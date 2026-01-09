import { getContext, extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "Simple Logic";
const extensionKey = "simple_logic";

/**
 * Simple Logic Extension

 * Adds a {{logic::...}} macro to parse a simplified IF/ELSE syntax.
 */

const getVariable = (varName) => {
    const context = getContext();
    // Try global first, then local/chat variables if needed. 
    // Usually macro variables in ST are global or temporary.
    // We will stick to global context.variables for now.
    const vars = context.variables;
    
    // Check if variables API is available (depending on ST version)
    if (vars && vars.global) {
       let val = vars.global.get(varName);
       // Attempt to return numbers as numbers
       if (!isNaN(parseFloat(val)) && isFinite(val)) {
           return parseFloat(val);
       }
       return val;
    }
    return null;
};

const setVariable = (varName, value) => {
    const context = getContext();
    if (context.variables && context.variables.global) {
        // Automatically quote strings if they are tokens, 
        // but for now we assume value is pre-processed or a raw string/number.
        context.variables.global.set(varName, value.toString());
    }
};

/**
 * Parses and evaluates the Simple Logic script.
 * @param {string} script - The raw script content from inside {{logic:: ... }}.
 * @returns {string} - The output text (accumulated via SAY commands).
 */
const evaluateLogic = (script) => {
    const lines = script.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    let outputBuffer = "";
    
    // State machine for execution
    // ignoringBlock: true if we are in a branch (IF/ELSE) that wasn't taken.
    let executionStack = [{ ignore: false, metCondition: false }];

    // Tokenizer regex
    // Matches: Strings "...", Keywords, Operators, or Identifiers
    const tokenRegex = /"([^"]*)"|([=><!]+)|(\w+)|(-?\d+(\.\d+)?)/g;

    const parseExpression = (exprString) => {
        // Very basic expression parser: Left OP Right
        // Support: age > 18, name == "Bob"
        
        // Remove "IF " or "ELSE IF " if present at start (though typically caller handles this)
        // clean up
        const parts = exprString.match(/"([^"]*)"|([=><!]+)|(\S+)/g); 
        
        if (!parts || parts.length < 3) return false;

        let leftVal = parts[0];
        const op = parts[1];
        let rightVal = parts[2];

        // Helper to resolve value (Variable or Literal)
        const resolve = (val) => {
            if (val.startsWith('"') && val.endsWith('"')) return val.slice(1, -1); // String literal
            if (!isNaN(parseFloat(val))) return parseFloat(val); // Number literal
            if (val === "true") return true;
            if (val === "false") return false;
            
            // Assume variable
            const lookedUp = getVariable(val);
            return lookedUp === null || lookedUp === undefined ? 0 : lookedUp; 
        };

        const v1 = resolve(leftVal);
        const v2 = resolve(rightVal);

        switch (op) {
            case '>': return v1 > v2;
            case '<': return v1 < v2;
            case '>=': return v1 >= v2;
            case '<=': return v1 <= v2;
            case '==': return v1 == v2; // loose equality matches JS behavior
            case '!=': return v1 != v2;
            default: return false;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const upperLine = line.toUpperCase();
        const currentScope = executionStack[executionStack.length - 1];

        // CONTROL FLOW: IF
        if (upperLine.startsWith("IF ")) {
            // Nested IF
            if (currentScope.ignore) {
                 executionStack.push({ ignore: true, metCondition: true }); // Ignore everything inside
                 continue;
            }
            
            const conditionStr = line.substring(3).trim();
            const result = parseExpression(conditionStr);
            executionStack.push({ ignore: !result, metCondition: result });
        }
        // CONTROL FLOW: ELSE IF
        else if (upperLine.startsWith("ELSE IF ")) {
             // Pop logic is tricky for flat structures, usually ELSE IF is same level as IF.
             // But strict structured programming implies it belongs to the previous IF chain.
             // We treat the current top stack as the block to toggle.
             
             if (executionStack.length <= 1) { outputBuffer += "[Error: ELSE IF without IF]"; continue; }
             
             const prevScope = executionStack[executionStack.length - 1];
             const parentScope = executionStack[executionStack.length - 2];
             
             // If parent is ignoring us, we continue ignoring
             if (parentScope && parentScope.ignore) {
                 prevScope.ignore = true;
                 prevScope.metCondition = true;
                 continue;
             }

             // If a previous branch was already met, we ignore this one
             if (prevScope.metCondition) {
                 prevScope.ignore = true;
             } else {
                 const conditionStr = line.substring(8).trim();
                 const result = parseExpression(conditionStr);
                 prevScope.ignore = !result;
                 if (result) prevScope.metCondition = true;
             }
        }
        // CONTROL FLOW: ELSE
        else if (upperLine.startsWith("ELSE")) {
             if (executionStack.length <= 1) { outputBuffer += "[Error: ELSE without IF]"; continue; }
             
             const prevScope = executionStack[executionStack.length - 1];
             const parentScope = executionStack[executionStack.length - 2];

             if (parentScope && parentScope.ignore) {
                 prevScope.ignore = true;
                 continue;
             }

             if (prevScope.metCondition) {
                 prevScope.ignore = true;
             } else {
                 prevScope.ignore = false;
                 prevScope.metCondition = true;
             }
        }
        // CONTROL FLOW: END
        else if (upperLine === "END") {
             if (executionStack.length > 1) {
                 executionStack.pop();
             }
        }
        // COMMAND: SAY
        else if (upperLine.startsWith("SAY ")) {
            if (!currentScope.ignore) {
                let text = line.substring(4).trim();
                // Strip quotes if present
                if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
                outputBuffer += text + " ";
            }
        }
        // COMMAND: SET
        else if (upperLine.startsWith("SET ")) {
            if (!currentScope.ignore) {
                // Syntax: SET varName = value
                const parts = line.substring(4).split("=");
                if (parts.length === 2) {
                    const varName = parts[0].trim();
                    let valStr = parts[1].trim();
                    // Basic strip quotes
                    if (valStr.startsWith('"') && valStr.endsWith('"')) valStr = valStr.slice(1, -1);
                    setVariable(varName, valStr);
                }
            }
        }
    }

    return outputBuffer.trim();
};

const defaultSettings = {
    scripts: []
};

function loadSettings() {
    if (!extension_settings[extensionKey]) {
        extension_settings[extensionKey] = defaultSettings;
    }
}

function getSavedScript(name) {
    const settings = extension_settings[extensionKey];
    if (!settings || !settings.scripts) return null;
    return settings.scripts.find(s => s.name === name);
}

// --- UI HANDLING ---

let selectedScriptIndex = -1;

function renderScriptList() {
    const listContainer = $('#simple-logic-list');
    listContainer.empty();
    
    const settings = extension_settings[extensionKey];
    const scripts = settings.scripts || [];

    scripts.forEach((script, index) => {
        const item = $(`<div class="menu_button ${index === selectedScriptIndex ? 'conf-btn-active' : ''}">${script.name}</div>`);
        item.on('click', () => {
             selectedScriptIndex = index;
             loadScriptToEditor();
             renderScriptList();
        });
        listContainer.append(item);
    });
}

function loadScriptToEditor() {
    const settings = extension_settings[extensionKey];
    const scripts = settings.scripts || [];
    
    if (selectedScriptIndex >= 0 && selectedScriptIndex < scripts.length) {
        const script = scripts[selectedScriptIndex];
        $('#simple-logic-name').val(script.name);
        $('#simple-logic-content').val(script.content);
        $('#simple-logic-usage').text(`{{logic::${script.name}}}`);
    } else {
        // Clear editor
        $('#simple-logic-name').val('');
        $('#simple-logic-content').val('');
        $('#simple-logic-usage').text('{{logic::scriptName}}');
    }
}

function saveCurrentScript() {
    const name = $('#simple-logic-name').val().trim();
    const content = $('#simple-logic-content').val();
    
    if (!name) return toastr.error('Script must have a name');
    
    const settings = extension_settings[extensionKey];
    if (!settings.scripts) settings.scripts = [];
    
    // Check if name exists (and isn't the one we are editing)
    const existingIndex = settings.scripts.findIndex(s => s.name === name);
    if (existingIndex !== -1 && existingIndex !== selectedScriptIndex) {
        return toastr.error('A script with this name already exists');
    }

    if (selectedScriptIndex >= 0 && selectedScriptIndex < settings.scripts.length) {
        // Update existing
        settings.scripts[selectedScriptIndex] = { name, content };
    } else {
        // Add new
        settings.scripts.push({ name, content });
        selectedScriptIndex = settings.scripts.length - 1;
    }
    
    saveSettingsDebounced();
    renderScriptList();
    loadScriptToEditor();
    toastr.success('Script saved');
}

function deleteCurrentScript() {
    if (selectedScriptIndex < 0) return;
    
    const settings = extension_settings[extensionKey];
    settings.scripts.splice(selectedScriptIndex, 1);
    selectedScriptIndex = -1;
    
    saveSettingsDebounced();
    renderScriptList();
    loadScriptToEditor();
}

jQuery(async () => {
    // 1. Load Settings UI
    try {
        // dynamic path detection using import.meta.url
        const extensionUrl = import.meta.url; 
        const extensionDir = extensionUrl.substring(0, extensionUrl.lastIndexOf('/'));
        
        const settingsHtml = await $.get(`${extensionDir}/settings.html`);
        $('#extensions_settings').append(settingsHtml);

        // 2. Init Settings
        loadSettings();

        // 3. Bind UI Events
        $('#simple-logic-add').on('click', () => {
            selectedScriptIndex = -1;
            $('#simple-logic-name').val('');
            $('#simple-logic-content').val('');
            renderScriptList();
        });
        
        $('#simple-logic-save').on('click', saveCurrentScript);
        $('#simple-logic-delete').on('click', deleteCurrentScript);
        
        // Initial Render
        renderScriptList();
    } catch (err) {
        console.error("[Simple Logic] Failed to load settings UI:", err);
        toastr.error("Simple Logic: Failed to load UI. Check console.");
    }



    // Register the macro
    // Note: ST extensions import context dynamically usually.
    // We hook into the macro registration system.
    
    // Wait for context to be ready or register immediately if possible
    // Using a polling retry or event is safer if `registerMacro` isn't immediately available globally
    // but typically `getContext` works.
    
    const registerLogicMacro = () => {
        try {
            const context = getContext();
            if (context && context.registerMacro) {
                context.registerMacro("logic", (arg) => {
                    // ARG contains the inner text of {{logic::ARG}}
                    if (!arg) return "";
                    try {
                        let scriptContent = arg;
                        
                        // Check if it's a saved script name
                        // We check if the argument contains newlines. If it has newlines, it's definitely raw code.
                        // If it's a single word, it might be a script name.
                        if (!arg.includes('\n')) {
                            const saved = getSavedScript(arg.trim());
                            if (saved) {
                                scriptContent = saved.content;
                            }
                        }

                        return evaluateLogic(scriptContent);
                    } catch (e) {
                        console.error("Simple Logic Error:", e);
                        return `[Logic Error: ${e.message}]`;
                    }
                });
                console.log("[Simple Logic] Macro registered.");
            } else {
                setTimeout(registerLogicMacro, 1000);
            }
        } catch (e) {
            console.warn("[Simple Logic] Retrying registration...");
            setTimeout(registerLogicMacro, 1000);
        }
    };
    
    registerLogicMacro();
});
