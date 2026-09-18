export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModeName = "plan" | "build";

export interface ModeModelSettings {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface NamedPreset {
  plan?: ModeModelSettings;
  build?: ModeModelSettings;
}

export interface ModeConfig {
  /** @deprecated Use presets instead. Kept for backward compatibility. */
  plan?: ModeModelSettings;
  /** @deprecated Use presets instead. Kept for backward compatibility. */
  build?: ModeModelSettings;
  presets?: Record<string, NamedPreset>;
  active?: string;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function normalizeModeSettings(value: unknown): ModeModelSettings | undefined {
  if (!isRecord(value)) return undefined;

  const settings: ModeModelSettings = {};

  if (typeof value.provider === "string" && value.provider.trim()) {
    settings.provider = value.provider.trim();
  }
  if (typeof value.model === "string" && value.model.trim()) {
    settings.model = value.model.trim();
  }
  if (isThinkingLevel(value.thinkingLevel)) {
    settings.thinkingLevel = value.thinkingLevel;
  }

  return Object.keys(settings).length > 0 ? settings : undefined;
}

function normalizeNamedPreset(value: unknown): NamedPreset | undefined {
  if (!isRecord(value)) return undefined;

  const preset: NamedPreset = {};
  const plan = normalizeModeSettings(value.plan);
  const build = normalizeModeSettings(value.build);

  if (plan) preset.plan = plan;
  if (build) preset.build = build;

  return Object.keys(preset).length > 0 ? preset : undefined;
}

export function normalizeModeConfig(value: unknown): ModeConfig {
  if (!isRecord(value)) return {};

  const config: ModeConfig = {};

  // Legacy top-level plan/build
  const plan = normalizeModeSettings(value.plan);
  const build = normalizeModeSettings(value.build);
  if (plan) config.plan = plan;
  if (build) config.build = build;

  // Named presets
  if (isRecord(value.presets)) {
    const presets: Record<string, NamedPreset> = {};
    for (const [name, preset] of Object.entries(value.presets)) {
      const normalized = normalizeNamedPreset(preset);
      if (normalized) {
        presets[name] = normalized;
      }
    }
    if (Object.keys(presets).length > 0) {
      config.presets = presets;
    }
  }

  // Active preset name
  if (typeof value.active === "string" && value.active.trim()) {
    config.active = value.active.trim();
  }

  return config;
}

function mergeModeSettings(
  base: ModeModelSettings | undefined,
  override: ModeModelSettings | undefined,
): ModeModelSettings | undefined {
  const merged = { ...(base ?? {}), ...(override ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeNamedPresets(
  base: Record<string, NamedPreset> | undefined,
  override: Record<string, NamedPreset> | undefined,
): Record<string, NamedPreset> | undefined {
  if (!base && !override) return undefined;
  const merged: Record<string, NamedPreset> = { ...(base ?? {}) };
  for (const [name, preset] of Object.entries(override ?? {})) {
    merged[name] = {
      plan: mergeModeSettings(merged[name]?.plan, preset.plan),
      build: mergeModeSettings(merged[name]?.build, preset.build),
    };
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeModeConfigs(base: ModeConfig, override: ModeConfig): ModeConfig {
  const merged: ModeConfig = {};

  // Legacy plan/build
  const plan = mergeModeSettings(base.plan, override.plan);
  const build = mergeModeSettings(base.build, override.build);
  if (plan) merged.plan = plan;
  if (build) merged.build = build;

  // Named presets
  const presets = mergeNamedPresets(base.presets, override.presets);
  if (presets) merged.presets = presets;

  // Active preset: override wins if set
  if (override.active !== undefined) {
    merged.active = override.active;
  } else if (base.active !== undefined) {
    merged.active = base.active;
  }

  return merged;
}

/** @deprecated Use getNamedPreset and setNamedPreset instead. */
export function setModeSettings(config: ModeConfig, mode: ModeName, settings: ModeModelSettings): ModeConfig {
  return {
    ...config,
    [mode]: normalizeModeSettings(settings) ?? {},
  };
}

export function getNamedPreset(config: ModeConfig, name: string): NamedPreset | undefined {
  return config.presets?.[name];
}

export function setNamedPreset(config: ModeConfig, name: string, preset: NamedPreset): ModeConfig {
  const presets = { ...(config.presets ?? {}) };
  const normalized = normalizeNamedPreset(preset);
  if (normalized) {
    presets[name] = normalized;
  }
  return { ...config, presets };
}

export function deleteNamedPreset(config: ModeConfig, name: string): ModeConfig {
  if (!config.presets || !(name in config.presets)) return config;
  const presets = { ...config.presets };
  delete presets[name];
  const result: ModeConfig = { ...config, presets };

  // Clean up: remove empty presets object
  if (Object.keys(presets).length === 0) {
    delete result.presets;
  }

  // Clear active if it was the deleted preset
  if (config.active === name) {
    result.active = undefined;
  }

  return result;
}

export function setActivePreset(config: ModeConfig, name: string | undefined): ModeConfig {
  return { ...config, active: name };
}

/**
 * Migrate legacy top-level plan/build to a named preset.
 * If presets exist, legacy values are ignored.
 */
export function migrateLegacyConfig(config: ModeConfig): ModeConfig {
  if (config.presets && Object.keys(config.presets).length > 0) return config;

  // If there are legacy plan/build but no presets, create a "default" preset
  if (config.plan || config.build) {
    const preset: NamedPreset = {};
    if (config.plan) preset.plan = config.plan;
    if (config.build) preset.build = config.build;

    return {
      presets: { default: preset },
      active: config.active ?? "default",
    };
  }

  return config;
}

export function serializeModeConfig(config: ModeConfig): string {
  const normalized = normalizeModeConfig(config);
  const clean: Record<string, unknown> = {};
  if (normalized.presets) {
    clean.presets = normalized.presets;
    if (normalized.active) clean.active = normalized.active;
  } else {
    if (normalized.plan) clean.plan = normalized.plan;
    if (normalized.build) clean.build = normalized.build;
  }
  return `${JSON.stringify(clean, null, 2)}\n`;
}
