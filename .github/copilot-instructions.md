# Copilot Instructions for SillyTavern Extension Development

This repository contains extensions for [SillyTavern](https://github.com/SillyTavern/SillyTavern). The primary extension in the root is **Simple Logic**, which adds programmable logic macros.

## Project Structure & Architecture

- **Context:** This is a client-side JavaScript extension that runs *inside* the SillyTavern browser environment. It is NOT a standalone app.
- **File Layout:**
  - `index.js`: The entry point. Handles macro registration, logic parsing, and core functionality.
  - `manifest.json`: Extension metadata (name, version, author).
  - `settings.html`: The configuration UI injected into SillyTavern's extensions panel.
  - `dev/`: Contains other extensions or experimental projects (e.g., `SillyTavern-DirectInjector`). Treat them as inspiration or examples.

## Development Workflow

1.  **Installation Location:**
    - To run this code, the repository must be placed in the SillyTavern extensions directory:
      `.../SillyTavern/public/scripts/extensions/third-party/sillytavern-simple-logic`
    - **Note:** Relative imports in `index.js` rely on this specific depth (`../../../extensions.js`).

2.  **Runtime Environment:**
    - The code runs in the browser.
    - It depends on global SillyTavern APIs available via imports (e.g., `getContext`, `saveSettingsDebounced`).

3.  **Testing:**
    - **No automated tests.** Testing requires manually running SillyTavern, enabling the extension, and using the `{{logic::...}}` macro in a chat message or prompt.
    - Example test case: `{{logic::IF 1 == 1\nSAY "It works"\nEND}}`.

## Code Conventions & Patterns

- **Core Imports:**
  - Import core SillyTavern modules using relative paths.
  - pattern: `import { ... } from "../../../extensions.js";`
  - pattern: `import { saveSettingsDebounced } from "../../../../script.js";`

- **State Management:**
  - Use `extension_settings[extensionKey]` to store persistent user configuration.
  - Use `getContext().variables` to access global SillyTavern variables (e.g., world info keys, chat variables).
  - **Do not** pollute the global `window` object unless necessary for debugging.

- **UI Implementation (`settings.html`):**
  - Use standard SillyTavern CSS classes for consistency:
    - `.inline-drawer`, `.inline-drawer-toggle`, `.inline-drawer-header`, `.inline-drawer-content` (Accordion style)
    - `.menu_button`, `.menu_button_icon` (Buttons)
    - `.text_pole` (Input fields)
    - `.smart-theme-border` (Theming)
  - ID prefixes: Ensure strictly unique IDs (e.g., `simple-logic-content`) to avoid collisions with other extensions.

- **Logic Parsing Strategy:**
  - The logic engine is a simple line-by-line interpreter with an execution stack.
  - Avoid complex AST usage; keep parsing lightweight (regex/split).

## Integration Points

- **Macros:** The extension registers itself via `SillyTavern`'s macro system (implied usage in prompt processing).
- **Variables:** Interacts primarily with `context.variables.global`.

## Extension Manifest

- Always update `manifest.json` when bumping versions for release.
- **Version Requirement:** Increment the `version` field in `manifest.json` for EVERY functional change to ensure users receive the update.
- Ensure the `name` acts as the unique identifier for extension loading.
