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
            if (val.toLowerCase() === "true") return true;
            if (val.toLowerCase() === "false") return false;
            
            // Cleanup Syntax: {{getvar::varName}} or {{varName}} -> varName
            let cleanVal = val;
            if (cleanVal.startsWith("{{")) {
                cleanVal = cleanVal.replace(/^{{\s*(getvar::)?/, "").replace(/}}$/, "").trim();
            }

            // Assume variable
            const lookedUp = getVariable(cleanVal);
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
    const settingsHtml = `
    <div id="simple-logic-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Simple Logic Library</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            
            <div class="inline-drawer-content">
                <div class="simple-logic-container" style="display: flex; gap: 10px; height: 500px;">
                    <!-- Left: List of Scripts -->
                    <div class="simple-logic-sidebar" style="flex: 1; border-right: 1px solid var(--smart-theme-border);">
                        <div style="margin-bottom: 5px;">
                            <div id="simple-logic-add" class="menu_button menu_button_icon" title="Create New Script">
                                <i class="fa-solid fa-plus"></i> New Script
                            </div>
                        </div>
                        <div id="simple-logic-list" style="overflow-y: auto; height: calc(100% - 40px); display: flex; flex-direction: column; gap: 2px;">
                            <!-- Script Items will be injected here -->
                        </div>
                    </div>

                    <!-- Right: Editor -->
                    <div class="simple-logic-editor-area" style="flex: 3; display: flex; flex-direction: column; gap: 10px;">
                        <div class="simple-logic-header" style="display: flex; gap: 10px; align-items: center;">
                            <span style="font-weight: bold;">Name:</span>
                            <input id="simple-logic-name" class="text_pole" type="text" placeholder="Script Name (e.g. combat_check)" style="flex: 1;" />
                            <div id="simple-logic-save" class="menu_button menu_button_icon" title="Save Script">
                                <i class="fa-solid fa-save"></i> Save
                            </div>
                            <div id="simple-logic-delete" class="menu_button menu_button_icon red" title="Delete Script">
                                <i class="fa-solid fa-trash"></i>
                            </div>
                        </div>

                        <div style="flex: 1; position: relative;">
                            <textarea id="simple-logic-content" class="text_pole" style="width: 100%; height: 100%; font-family: monospace; resize: none;" 
                            placeholder="IF age > 18&#10;  SAY 'Adult'&#10;ELSE&#10;  SAY 'Minor'&#10;END"></textarea>
                        </div>

                        <div class="simple-logic-footer">
                            <small>Usage: <code id="simple-logic-usage">{{logic::scriptName}}</code> OR <code id="simple-logic-raw-usage">{{logic::Raw Code}}</code></small>
                        </div>
                    </div>
                </div>
                
                <hr>
                <div style="margin-top: 10px;">
                    <i>Variable Helper: Use <code>SET var = value</code> to set, and just use variable names in IF conditions.</i>
                </div>
            </div>
        </div>
    </div>`;

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




    // Register the macro
    // Note: ST extensions import context dynamically usually.
    // We hook into the macro registration system.
    
    // Wait for context to be ready or register immediately if possible
    // Using a polling retry or event is safer if `registerMacro` isn't immediately available globally
    // but typically `getContext` works.
    
    const registerLogicMacro = () => {
        try {
            // Define the handler function separately to reuse it
            const logicMacroHandler = (arg) => {
                // ARG contains the inner text of {{logic::ARG}}
                if (!arg) return "";
                try {
                    let scriptContent = arg;
                    
                    // Check if it's a saved script name
                    // We check if the argument contains newlines. If it has newlines, it's definitely raw code.
                    // If it's a single word, it might be a script name.
                    if (!arg.includes('\n')) {
                        // Trim and ensure we handle cases where getSavedScript might fail silently
                        const scriptName = arg.trim();
                        const saved = getSavedScript(scriptName);
                        if (saved) {
                            scriptContent = saved.content;
                            console.log(`[Simple Logic] Found saved script '${scriptName}'`);
                        } else {
                            console.log(`[Simple Logic] No script found named '${scriptName}', assuming raw code.`);
                        }
                    }

                    return evaluateLogic(scriptContent);
                } catch (e) {
                    console.error("Simple Logic Error:", e);
                    return `[Logic Error: ${e.message}]`;
                }
            };
            
            // Try explicit global access to macros.registry (SillyTavern Standard)
            if (window.macros && window.macros.registry) {
                 window.macros.registry.registerMacro("logic", logicMacroHandler, ["script_or_name"]);
                 console.log("[Simple Logic] Registered via window.macros.registry");
                 return;
            } 
            
            // Fallback: Context API
            const context = getContext();
            if (context && context.registerMacro) {
                // Pass third argument for parameters to satisfy the parser
                context.registerMacro("logic", logicMacroHandler, ["script_or_name"]);
                console.log("[Simple Logic] Registered via context.registerMacro");
            } else {
                setTimeout(registerLogicMacro, 1000);
            }
        } catch (e) {
            console.warn("[Simple Logic] Retrying registration...", e);
            setTimeout(registerLogicMacro, 1000);
        }
    };
                        const scriptName = arg.trim();
                        const saved = getSavedScript(scriptName);
                        if (saved) {
                            scriptContent = saved.content;
                            console.log(`[Simple Logic] Found saved script '${scriptName}'`);
                        } else {
                            console.log(`[Simple Logic] No script found named '${scriptName}', assuming raw code.`);
                        }
                    }

                    return evaluateLogic(scriptContent);
                } catch (e) {
                    console.error("Simple Logic Error:", e);
                    return `[Logic Error: ${e.message}]`;
                }
            };

            // Expected arguments configuration for the macro
            const macroParams = ["script_or_name"];

            // Strategy 1: Global 'macros' object
            // This bypasses potential issues where registerMacro wrappers drop arguments.
            const globalMacros = window.macros || (window.SillyTavern && window.SillyTavern.macros);
            if (globalMacros) {
                 globalMacros.register("logic", logicMacroHandler, macroParams);
                 console.log("[Simple Logic] Macro registered via global macros.");
                 return;
            }

            // Strategy 2: Context registerMacro (fallback)
            if (context && context.registerMacro) {
                // Pass third argument for parameters to satisfy the parser
                context.registerMacro("logic", logicMacroHandler, macroParams);
                console.log("[Simple Logic] Macro registered via context.registerMacro.");
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
