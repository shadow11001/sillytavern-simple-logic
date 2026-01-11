import { getContext, extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, substituteParams } from "../../../../script.js";

const extensionName = "Simple Logic";
const extensionKey = "simple_logic";

/**
 * Simple Logic Extension

 * Adds a {{logic::...}} macro to parse a simplified IF/ELSE syntax.
 */

const getVariable = (varName) => {
    const context = getContext();
    const vars = context.variables;
    
    // Helper to get from Obj or Map
    const get = (storage, key) => {
        if (!storage) return undefined;
        if (typeof storage.get === 'function') return storage.get(key);
        return storage[key];
    };

    if (vars) {
        // 1. Global (Only)
        let val = get(vars.global, varName);
        if (val !== undefined) return normalizeValue(val);
    }
    
    // 2. Fallbacks (Direct Global/Window access)
    // Only check global_variables
    if (typeof window !== 'undefined') {
        if (window.global_variables) {
            let val = window.global_variables[varName];
             if (val !== undefined) return normalizeValue(val);
        }
    }

    return null;
};

const normalizeValue = (val) => {
    if (!isNaN(parseFloat(val)) && isFinite(val)) return parseFloat(val);
    if (val === "true") return true; 
    if (val === "false") return false;
    return val;
}

const setVariable = (varName, value) => {
    const context = getContext();
    const vars = context.variables;
    const valStr = value.toString();

    let setSuccess = false;

    // Helper to set to Obj or Map
    const set = (storage, key, val) => {
        if (!storage) return false;
        if (typeof storage.set === 'function') {
            storage.set(key, val);
            return true;
        }
        storage[key] = val;
        return true;
    };

    if (vars) {
        // 1. Force Global
        if (vars.global) {
             set(vars.global, varName, valStr);
             setSuccess = true;
        }
    }

    // 3. Fallback Writing (ensure persistence)
    if (!setSuccess && typeof window !== 'undefined') {
         if (window.global_variables) {
             window.global_variables[varName] = valStr;
             setSuccess = true;
         }
    }

    if (setSuccess) {
        console.debug(`[SimpleLogic] SETVAR "${varName}" = "${valStr}"`);
        saveSettingsDebounced();
    } else {
        console.warn(`[SimpleLogic] SETVAR Failed for "${varName}" - No storage found!`);
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
        
        if (!parts) {
            console.debug(`[SimpleLogic] Failed to parse expr: "${exprString}"`);
            return false;
        }

        let leftVal, op, rightVal;
        
        // Handle Missing LHS (e.g. " < 12" -> 0 < 12)
        // This commonly happens if a variable macro resolves to empty string.
        if (parts.length === 2 && /^[=><!]+$/.test(parts[0])) {
            leftVal = 0;
            op = parts[0];
            rightVal = parts[1];
            console.debug(`[SimpleLogic] Missing LHS. Defaulting to 0. Expr: "0 ${op} ${rightVal}"`);
        } else if (parts.length >= 3) {
            leftVal = parts[0];
            op = parts[1];
            rightVal = parts[2];
        } else {
            console.debug(`[SimpleLogic] Invalid part count: ${parts.length}`);
            return false;
        }

        // Helper to resolve value (Variable or Literal)
        const resolve = (val) => {
            if (typeof val === 'number') return val;
            if (typeof val !== 'string') return val;

            if (val.startsWith('"') && val.endsWith('"')) return val.slice(1, -1); // String literal
            if (!isNaN(parseFloat(val))) return parseFloat(val); // Number literal
            if (val.toLowerCase() === "true") return true;
            if (val.toLowerCase() === "false") return false;
            if (val.toUpperCase() === "RANDOM") return Math.random(); // 0.0 to 1.0
            
            // Cleanup Syntax: {{getvar::varName}} or {{varName}} -> varName
            let cleanVal = val;
            // Note: If ST already resolved {{getvar::...}} to "", this loop receives "" which resolve() treats as variable logic likely fails or becomes 0.
            if (cleanVal.startsWith("{{")) {
                cleanVal = cleanVal.replace(/^{{\s*(getvar::)?/, "").replace(/}}$/, "").trim();
            }

            // Assume variable
            const lookedUp = getVariable(cleanVal);
            console.debug(`[SimpleLogic] Resolve "${val}" -> Var "${cleanVal}" -> Value:`, lookedUp);
            return lookedUp === null || lookedUp === undefined ? 0 : lookedUp; 
        };

        const v1 = resolve(leftVal);
        const v2 = resolve(rightVal);

        console.debug(`[SimpleLogic] Compare: ${v1} ${op} ${v2}`);

        switch (op) {
            case '>': return v1 > v2;
            case '<': return v1 < v2;
            case '>=': return v1 >= v2;
            case '<=': return v1 <= v2;
            case '==': return v1 == v2; // loose equality matches JS behavior
            case '=': return v1 == v2; // forgiving assignment-as-equality
            case '!=': return v1 != v2;
            case 'CONTAINS': 
            case 'HAS':
                return String(v1).toLowerCase().includes(String(v2).toLowerCase());
            default: return false;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        let rawLine = lines[i];
        let upperLine = rawLine.trim().toUpperCase();
        let currentScope = executionStack[executionStack.length - 1];

        // Optimization: In ignored blocks, skip macro substitution unless we need to check control flow.
        // We only strictly need IF/ELSE/END to maintain stack integrity.
        // We do NOT want to execute macros ({{setvar::...}}) inside ignored blocks.
        if (currentScope.ignore) {
            // Check for control flow keywords in the raw line
            // This assumes keywords are not dynamically generated by macros.
            if (upperLine.startsWith("IF ")) {
                executionStack.push({ ignore: true, metCondition: true }); 
                continue;
            }
            if (upperLine.startsWith("ELSE IF ")) {
                 // Even if it's an ELSE IF, if we are in ignore mode from a parent, 
                 // or from a previous sibling IF that was true, we stay ignored.
                 // We don't even parse the condition.
                 // However, we need to handle the stack logic for "chaining".
                 // Actually, if we are ignored, we just continue ignoring unless 
                 // we are in the specific state of "Looking for ELSE/ELSE IF after a failure".
            } else if (!upperLine.startsWith("ELSE") && upperLine !== "END") {
                // Not a control structure? Completely skip.
                continue;
            }
        }
        
        // Expand macros ({{char}}, {{user}}, {{random}}, etc.) safely now
        const line = substituteParams(rawLine);
        upperLine = line.trim().toUpperCase();
        currentScope = executionStack[executionStack.length - 1]; 

        // Debug Logging (Temporary, via Browser Console)
        console.debug(`[SimpleLogic] Line: "${line}" | Upper: "${upperLine}"`);

        // CONTROL FLOW: IF
        if (upperLine.startsWith("IF ")) {
            // Nested IF
            if (currentScope.ignore) {
                 executionStack.push({ ignore: true, metCondition: true }); // Ignore everything inside
                 continue;
            }
            
            // Special Keywords Pre-processing
            let conditionStr = line.substring(3).trim();
            // Handle LAST_MESSAGE keyword
            if (conditionStr.includes("LAST_MESSAGE")) {
                const context = getContext();
                let msg = "";
                if (context.chat && context.chat.length > 0) {
                     msg = context.chat[context.chat.length - 1].mes;
                     // Sanitize for string comparison
                     msg = msg.replace(/"/g, "'");
                }
                conditionStr = conditionStr.replace(/LAST_MESSAGE/g, `"${msg}"`);
            }
            
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
                 let conditionStr = line.substring(8).trim();
                 // Handle LAST_MESSAGE keyword
                 if (conditionStr.includes("LAST_MESSAGE")) {
                     const context = getContext();
                     let msg = "";
                     if (context.chat && context.chat.length > 0) {
                          msg = context.chat[context.chat.length - 1].mes;
                          msg = msg.replace(/"/g, "'");
                     }
                     conditionStr = conditionStr.replace(/LAST_MESSAGE/g, `"${msg}"`);
                 }

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
        // COMMAND: SET (Legacy/Simple)
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
        // COMMAND: SETVAR (Explicit Typed)
        else if (upperLine.startsWith('SETVAR ')) {
            if (!currentScope.ignore) {
                const content = line.substring(7).trim();
                const firstSpace = content.indexOf(' ');
                
                if (firstSpace !== -1) {
                    const varName = content.substring(0, firstSpace).trim();
                    let varValueRaw = content.substring(firstSpace + 1).trim();
                    let varValue;

                    // Simple type inference
                    if (varValueRaw.startsWith('"') && varValueRaw.endsWith('"')) {
                        // It's a string, strip quotes
                        varValue = varValueRaw.slice(1, -1);
                    } else if (!isNaN(parseFloat(varValueRaw)) && isFinite(varValueRaw)) {
                        // It's a number
                        varValue = parseFloat(varValueRaw);
                    } else if (varValueRaw.toLowerCase() === 'true') {
                        varValue = true;
                    } else if (varValueRaw.toLowerCase() === 'false') {
                        varValue = false;
                    } else {
                        // Treat as string fallback or variable lookup?
                        // For now, simple fallback to string
                        varValue = varValueRaw;
                    }

                    // Apply to SillyTavern Context
                    setVariable(varName, varValue);
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

// --- AI ANALYSIS HELPERS ---

async function generateAnalysis() {
    // 1. Get Params
    const profileId = $('#simple-logic-ai-profile').val();
    const depth = parseInt($('#simple-logic-ai-depth').val()) || 15;
    const source = $('#simple-logic-ai-source').val() || 'all';
    const mode = $('#simple-logic-ai-mode').val() || 'script';

    const context = getContext();
    const service = context.ConnectionManagerRequestService;

    if (!service) return toastr.error("Connection Manager not found. Update SillyTavern.");
    if (!profileId) return toastr.error("Select a Connection Profile first.");

    $('#simple-logic-ai-result').html("<i>Generating analysis... please wait...</i>").show();

    // 2. Build History
    let chat = context.chat || [];
    if (source === 'user') chat = chat.filter(m => m.is_user);
    if (source === 'char') chat = chat.filter(m => !m.is_user);

    const history = chat.slice(-depth).map(msg => {
        return `${msg.is_user ? 'User' : (msg.name || 'Char')}: ${msg.mes}`;
    }).join("\n");

    // 3. Construct System Prompt
    let instructions = "";
    if (mode === 'script') {
        instructions = `Then, create 3 unique "Simple Logic" Scripts to introduce randomness or events.
    
    The Script Format is:
    IF RANDOM < 0.3
      SAY "Something unexpected happens."
      SETVAR something "true"
    ELSE
      SAY "Things remain calm."
    END
    
    Use the keyword LAST_MESSAGE to check the last text effectively (e.g. IF LAST_MESSAGE CONTAINS "fight").`;
    } 
    else if (mode === 'keywords') {
        instructions = `Often, simple keyword checks are safer than random events. 
        Suggest 5 specific keywords or phrases found in the text that would be good triggers.
        Return them as snippets like: IF LAST_MESSAGE CONTAINS "sword" ... END`;
    }
    else {
        instructions = `Analyze the roleplay dynamic. Suggest what kind of Logic Scripts (Random events, state tracking) would improve it. 
        Return the suggestions in the code block as comments or pseudo-code snippets.`;
    }

    const prompt = `Analyze the following Roleplay Chat history (Last ${depth} messages). 
    Identify the current narrative tone and logical next steps. 
    ${instructions}
    
    Output ONLY a JSON object with this structure:
    {
       "analysis": "Short summary of tone",
       "suggestions": [
           { "name": "Event Name", "code": "IF ... END" },
           { "name": "Event Name 2", "code": "IF ... END" }
       ]
    }
    
    Chat History:
    ${history}`;

    // 4. Send Request
    try {
        const messages = [{ role: 'user', content: prompt }];
        const responseCallback = await service.sendRequest(profileId, messages, 600);
        
        // Handle stream or text
        let resultText = "";
        if (responseCallback && typeof responseCallback === 'string') {
             resultText = responseCallback;
        } else if (responseCallback && responseCallback.content) {
             resultText = responseCallback.content;
        }

        // 5. Parse JSON
        // Clean markdown code blocks if present
        resultText = resultText.replace(/```json/g, "").replace(/```/g, "").trim();
        const json = JSON.parse(resultText);
        
        displayAnalysisResults(json);

    } catch (e) {
        console.error(e);
        $('#simple-logic-ai-result').text("Error: " + e.message);
    }
}

function displayAnalysisResults(data) {
    const container = $('#simple-logic-ai-result');
    container.empty();
    
    container.append(`<div><b>Analysis:</b> ${data.analysis}</div><hr>`);
    
    data.suggestions.forEach(s => {
        const card = $(`
            <div style="border: 1px solid var(--smart-theme-border); padding: 5px; margin-bottom: 5px; border-radius: 5px; background: rgba(0,0,0,0.2);">
                <div style="display:flex; justify-content:space-between;">
                    <b>${s.name}</b>
                    <div class="menu_button menu_button_icon" title="Copy to Editor"><i class="fa-solid fa-paste"></i> Use</div>
                </div>
                <pre style="font-size:0.8em; overflow-x:auto;">${s.code}</pre>
            </div>
        `);
        
        card.find('.menu_button').on('click', () => {
             $('#simple-logic-name').val(s.name);
             $('#simple-logic-content').val(s.code);
             toastr.info("Script copied to editor. Click Save to keep it.");
        });
        
        container.append(card);
    });
}

function refreshProfiles() {
    const context = getContext();
    const select = $('#simple-logic-ai-profile');
    select.empty();
    select.append('<option value="">-- Select AI Profile --</option>');
    
    if (context.extensionSettings && context.extensionSettings.connectionManager) {
        const profiles = context.extensionSettings.connectionManager.profiles || [];
        profiles.forEach(p => {
            select.append(`<option value="${p.id}">${p.name}</option>`);
        });
    }
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
                        <div id="simple-logic-list" style="overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 2px;">
                            <!-- Script Items will be injected here -->
                        </div>
                        
                        <!-- AI Analysis Section -->
                        <div style="border-top: 1px solid var(--smart-theme-border); padding-top: 10px; margin-top: 5px; display: flex; flex-direction: column; gap: 5px;">
                             <b>AI Auto-Script</b>
                             
                             <select id="simple-logic-ai-profile" class="text_pole" style="width:100%;" title="Connection Profile"></select>
                             
                             <div style="display: flex; gap: 5px;">
                                <input id="simple-logic-ai-depth" class="text_pole" type="number" value="15" min="1" max="100" style="width: 50%;" title="Analysis Depth (Messages)" placeholder="15" />
                                <select id="simple-logic-ai-source" class="text_pole" style="width: 50%;" title="Message Source">
                                    <option value="all">All Sources</option>
                                    <option value="user">User Only</option>
                                    <option value="char">Char Only</option>
                                </select>
                             </div>
                             
                             <select id="simple-logic-ai-mode" class="text_pole" style="width:100%;" title="Output Mode">
                                <option value="script">Generate Scripts</option>
                                <option value="keywords">Suggest Keywords</option>
                                <option value="critique">Analysis Only</option>
                             </select>

                             <div id="simple-logic-analyze-btn" class="menu_button">Analyze Chat</div>
                        </div>
                    </div>

                    <!-- Right: Editor & Results -->
                    <div class="simple-logic-editor-area" style="flex: 2; display: flex; flex-direction: column; gap: 10px;">
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
                            placeholder="IF LAST_MESSAGE CONTAINS 'fight'&#10;  IF RANDOM < 0.5&#10;    SAY 'The enemy flinches!'&#10;  END&#10;END"></textarea>
                        </div>
                        
                        <!-- AI Results Overlay (Hidden by default, shown when results exist) -->
                        <div id="simple-logic-ai-result" style="max-height: 150px; overflow-y: auto; border: 1px dashed var(--smart-theme-border); padding: 5px; display: none;"></div>

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
    renderScriptList();

    // 3. Bind UI Events
    $('#simple-logic-add').on('click', () => { selectedScriptIndex = -1; loadScriptToEditor(); });
    $('#simple-logic-save').on('click', saveCurrentScript);
    $('#simple-logic-delete').on('click', deleteCurrentScript);

    // AI Analysis Bindings
    $('#simple-logic-analyze-btn').on('click', ()=> {
        $('#simple-logic-ai-result').show();
        generateAnalysis();
    });
    
    // Refresh profiles on drawer open or init
    $(document).on('click', '.inline-drawer-toggle', () => {
         setTimeout(refreshProfiles, 500);
    });
    refreshProfiles();

    // Register the macro
    const registerLogicMacro = () => {
        try {
            // Define the handler function separately to reuse it
            // New signature: receives a Context Object
            function logicMacroHandler(data) {
                // If data is a string (Legacy Legacy), handle it
                let args = data; 
                // If data is object (Modern), extract args[0]
                if (typeof data === 'object' && data !== null) {
                     if (Array.isArray(data.args) && data.args.length > 0) {
                         args = data.args[0];
                     } else if (typeof data.args === 'string') {
                         args = data.args;
                     } else {
                         args = ""; // No args provided
                     }
                }

                if (!args || typeof args !== 'string') return "";
                
                try {
                    let scriptContent = args;
                    
                    // Check if it's a saved script name
                    // We check if the argument contains newlines. If it has newlines, it's definitely raw code.
                    // If it's a single word, it might be a script name.
                    if (!args.includes('\n')) {
                        // Trim and ensure we handle cases where getSavedScript might fail silently
                        const scriptName = args.trim();
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
            }
            
            // Expected arguments configuration for the macro
            // New registry signature requires an Options object
            const macroOptions = {
                handler: logicMacroHandler,
                description: "Simple Logic Script Executor",
                unnamedArgs: [
                    {
                        name: "script",
                        type: "string",
                        description: "Script Name or Content"
                    }
                ]
            };

            // SEARCH FOR THE MACRO REGISTRY
            // We need to find the underlying registry because context.registerMacro often fails to pass arguments correctly.
            let macrosAPI = null;

            // 1. Direct window export (some versions)
            if (window.macros) macrosAPI = window.macros;
            // 2. SillyTavern global namespace
            else if (window.SillyTavern && window.SillyTavern.macros) macrosAPI = window.SillyTavern.macros;
            // 3. Via Context (some versions expose it)
            else {
                const ctx = getContext();
                if (ctx && ctx.macros) macrosAPI = ctx.macros;
            }

            // REGISTER
            let registered = false;
            
            // Modern "register" method (preferred public API)
            if (macrosAPI && typeof macrosAPI.register === 'function') {
                 try {
                     macrosAPI.register("simplelogic", macroOptions);
                     console.log("[Simple Logic] Registered 'simplelogic' via macros.register().");
                     registered = true;
                 } catch (regErr) {
                     console.error("[Simple Logic] macros.register() Failed:", regErr);
                 }
            }
            // Internal "registry.registerMacro" (fallback for older staging)
            else if (macrosAPI && macrosAPI.registry && macrosAPI.registry.registerMacro) {
                 try {
                     macrosAPI.registry.registerMacro("simplelogic", macroOptions);
                     console.log("[Simple Logic] Registered 'simplelogic' via registry.registerMacro().");
                     registered = true;
                 } catch (regErr) {
                     console.error("[Simple Logic] registry.registerMacro() Failed:", regErr);
                 }
            } 
            
            if (registered) return;

            // Fallback: Context API (Legacy)
            const context = getContext();
            if (context && context.registerMacro) {
                // If legacy, we pass the old signature (name, handler, paramsArray)
                console.warn("[Simple Logic] Warning: Using legacy context.registerMacro. Arguments may fail.");
                // Note: Legacy expects handler to take 'arg' string directly.
                // Our unified handler checks type, so it should auto-adapt.
                context.registerMacro("simplelogic", logicMacroHandler, ["script"]);
            } else {
                console.log("[Simple Logic] Registry not found yet, retrying...");
                setTimeout(registerLogicMacro, 1000);
            }
        } catch (e) {
            console.warn("[Simple Logic] Retrying registration...", e);
            setTimeout(registerLogicMacro, 1000);
        }
    };
    
    registerLogicMacro();
});
