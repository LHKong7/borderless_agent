/**
 * skillLifecycle.ts — Manages the set of currently-loaded skills.
 *
 * Backed by a SkillRegistry (read-only catalog) and tracks per-session
 * load state, runs onLoad / onUnload hooks, and resolves dependencies
 * transitively. The `getActiveSkillBodies()` accessor is what
 * ContextBuilder reads each turn to inject skill content into the
 * system prompt.
 *
 * Telemetry: emits `skill.load` and `skill.unload` spans when a
 * Telemetry instance is provided.
 */

import { SkillDefinition, SkillContext } from './types';
import { SkillRegistry } from './skillRegistry';
import type { Telemetry } from './telemetry';

export interface SkillLoadResult {
    success: boolean;
    skillName: string;
    /** Names of dependencies that were also loaded as part of this call. */
    loadedDependencies: string[];
    error?: string;
}

export interface SkillLifecycleManagerOptions {
    registry: SkillRegistry;
    telemetry?: Telemetry;
    sessionId?: string;
}

export class SkillLifecycleManager {
    private readonly _registry: SkillRegistry;
    private readonly _telemetry?: Telemetry;
    private readonly _sessionId?: string;
    private readonly _active: Set<string> = new Set();
    private readonly _contexts: Map<string, SkillContext> = new Map();

    constructor(options: SkillLifecycleManagerOptions) {
        this._registry = options.registry;
        this._telemetry = options.telemetry;
        this._sessionId = options.sessionId;
    }

    get registry(): SkillRegistry { return this._registry; }

    isLoaded(name: string): boolean { return this._active.has(name); }
    getActive(): string[] { return Array.from(this._active); }

    /**
     * Returns active skill bodies in load order. ContextBuilder injects
     * these as `skill:<name>` sources into the per-turn system prompt.
     */
    getActiveSkillBodies(): { name: string; body: string }[] {
        return Array.from(this._active).map((n) => {
            const s = this._registry.get(n)!;
            return { name: n, body: s.body };
        });
    }

    async loadSkill(name: string): Promise<SkillLoadResult> {
        const span = this._telemetry?.startSpan('skill.load', { attributes: { 'skill.name': name } });
        const result: SkillLoadResult = {
            success: false,
            skillName: name,
            loadedDependencies: [],
        };
        try {
            if (!this._registry.has(name)) {
                result.error = 'SKILL_NOT_FOUND';
                span?.setStatus('error', 'SKILL_NOT_FOUND');
                return result;
            }

            // Resolve dependencies (topological order ending with `name`).
            const deps = this._registry.resolveDependencies(name);
            for (const dep of deps) {
                if (this._active.has(dep.name)) continue;
                await this._invokeOnLoad(dep);
                this._active.add(dep.name);
                if (dep.name !== name) result.loadedDependencies.push(dep.name);
            }
            result.success = true;
            return result;
        } catch (e: any) {
            result.error = e?.message ?? String(e);
            span?.setStatus('error', result.error);
            return result;
        } finally {
            span?.setAttribute('skill.load.success', result.success);
            span?.end();
        }
    }

    async unloadSkill(name: string): Promise<void> {
        if (!this._active.has(name)) return;
        const skill = this._registry.get(name);
        const span = this._telemetry?.startSpan('skill.unload', { attributes: { 'skill.name': name } });
        try {
            if (skill?.onUnload) {
                const ctx = this._contexts.get(name) ?? this._newContext();
                await Promise.resolve(skill.onUnload(ctx));
            }
            this._active.delete(name);
            this._contexts.delete(name);
        } catch (e: any) {
            span?.setStatus('error', e?.message ?? String(e));
        } finally {
            span?.end();
        }
    }

    /**
     * Auto-load every skill whose trigger fires against `input`. Returns
     * the names that were newly loaded (already-active skills are skipped).
     */
    async autoLoadFromTriggers(input: string): Promise<string[]> {
        const candidates = this._registry.matchTriggers(input);
        const newlyLoaded: string[] = [];
        for (const s of candidates) {
            if (this._active.has(s.name)) continue;
            const r = await this.loadSkill(s.name);
            if (r.success) newlyLoaded.push(s.name);
        }
        return newlyLoaded;
    }

    private async _invokeOnLoad(skill: SkillDefinition): Promise<void> {
        if (!skill.onLoad) return;
        const ctx = this._newContext();
        this._contexts.set(skill.name, ctx);
        await Promise.resolve(skill.onLoad(ctx));
    }

    private _newContext(): SkillContext {
        return { sessionId: this._sessionId, scratch: {} };
    }
}
