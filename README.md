# pi-plan-build-mode

Plan/build mode switching and named model presets for Pi. The npm package contains two Pi extension entries, `plan-build-mode` and `plan-build-preset`, in the sibling layout required by their relative imports.

## Requirements

- Node.js 20 or newer.
- Pi (`@earendil-works/pi-coding-agent`).
- A Pi model/provider configuration for any models selected in presets.

## Installation

```sh
pi install npm:@yukikisaku/pi-plan-build-mode
```

Both extension entries are declared by the package manifest and load together by default.

## Usage

Pi starts interactive sessions in Plan mode. Press `Shift+Tab` to switch between Plan and Build mode. The footer shows `⏸ plan` or `⏵⏵ build`.

Plan mode blocks Pi's `edit` and `write` tools, blocks the built-in `powershell` tool entirely, and rejects `bash` commands that the bundled mutation guard recognizes as definite filesystem, package-manager, Git, or similar mutations. Build mode removes those Plan-mode blocks. The guard is a safety aid rather than an operating-system sandbox; third-party tools can have their own side effects.

The extension injects a hidden reminder for the active mode before agent work. The default reminder assets are `mode-prompts/plan.md` and `mode-prompts/build.md` inside the package.

Use `/preset` to manage named Plan/Build model presets:

```text
/preset
/preset list
/preset add [name]
/preset edit <name>
/preset delete <name>
/preset <name>
```

Each preset can select a provider, model, and thinking level independently for Plan and Build mode. Activating a preset immediately applies the settings for the current mode.

## Configuration

Configuration is read from these locations, with project settings overriding global settings:

- Global: `$PI_CODING_AGENT_DIR/plan-build-mode.json` (normally `~/.pi/agent/plan-build-mode.json`)
- Project: `<project>/.pi/plan-build-mode.json`

Legacy `plan-mode.json` files are also read for compatibility. When no writable project config already exists, `/preset` saves to the global config.

Example:

```json
{
  "presets": {
    "work": {
      "plan": {
        "provider": "openai-codex",
        "model": "gpt-5.6-sol",
        "thinkingLevel": "high"
      },
      "build": {
        "provider": "openai-codex",
        "model": "gpt-5.6-sol",
        "thinkingLevel": "xhigh"
      }
    }
  },
  "active": "work"
}
```

Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Model switching occurs only when both `provider` and `model` are present.

You can override the bundled mode reminder files with `PI_PLAN_MODE_PROMPT` and `PI_BUILD_MODE_PROMPT`. Absolute paths are used directly; relative paths are resolved from the packaged `mode-prompts` directory.

## Uninstallation

```sh
pi remove npm:@yukikisaku/pi-plan-build-mode
```

Uninstalling the package does not delete `plan-build-mode.json` or legacy `plan-mode.json` configuration files.

## Pull requests

Pull requests are reviewed by AI and automatically merged when the review and CI pass.

## License

MIT
