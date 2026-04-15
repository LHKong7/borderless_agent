/**
 * skillRegistry.ts — Indexed registry over user-supplied SkillDefinitions.
 *
 * Provides lookup by name / category / tag, full-text search, and
 * dependency resolution (with cycle detection). The registry is read-
 * mostly: register skills once at agent build time and query repeatedly
 * during turns.
 */

import { SkillDefinition } from './types';

export class SkillRegistry {
    private readonly _byName: Map<string, SkillDefinition> = new Map();
    private readonly _byCategory: Map<string, Set<string>> = new Map();
    private readonly _byTag: Map<string, Set<string>> = new Map();

    constructor(skills: SkillDefinition[] = []) {
        for (const s of skills) this.register(s);
    }

    register(skill: SkillDefinition): void {
        if (this._byName.has(skill.name)) {
            throw new Error(`Skill already registered: ${skill.name}`);
        }
        this._byName.set(skill.name, skill);
        for (const cat of skill.categories ?? []) {
            if (!this._byCategory.has(cat)) this._byCategory.set(cat, new Set());
            this._byCategory.get(cat)!.add(skill.name);
        }
        for (const tag of skill.tags ?? []) {
            if (!this._byTag.has(tag)) this._byTag.set(tag, new Set());
            this._byTag.get(tag)!.add(skill.name);
        }
    }

    get(name: string): SkillDefinition | undefined { return this._byName.get(name); }
    has(name: string): boolean { return this._byName.has(name); }
    list(): SkillDefinition[] { return Array.from(this._byName.values()); }
    listCategories(): string[] { return Array.from(this._byCategory.keys()); }
    listTags(): string[] { return Array.from(this._byTag.keys()); }

    listByCategory(category: string): SkillDefinition[] {
        const names = this._byCategory.get(category);
        if (!names) return [];
        return Array.from(names).map((n) => this._byName.get(n)!).filter(Boolean);
    }

    listByTag(tag: string): SkillDefinition[] {
        const names = this._byTag.get(tag);
        if (!names) return [];
        return Array.from(names).map((n) => this._byName.get(n)!).filter(Boolean);
    }

    /**
     * Walk the dependency graph for `name` and return all skills (including
     * `name` itself) topologically. Cycles are detected and silently broken
     * — each skill appears at most once in the result.
     */
    resolveDependencies(name: string): SkillDefinition[] {
        const out: SkillDefinition[] = [];
        const visited = new Set<string>();
        const visit = (n: string) => {
            if (visited.has(n)) return;
            visited.add(n);
            const s = this._byName.get(n);
            if (!s) return;
            for (const dep of s.dependencies ?? []) visit(dep);
            out.push(s);
        };
        visit(name);
        return out;
    }

    /**
     * Lightweight scoring search over name/description/tags.
     * Returns up to `limit` skills sorted by descending relevance.
     */
    search(query: string, limit: number = 10): SkillDefinition[] {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const scored: { score: number; skill: SkillDefinition }[] = [];
        for (const s of this._byName.values()) {
            let score = 0;
            if (s.name.toLowerCase().includes(q)) score += 0.6;
            if (s.description.toLowerCase().includes(q)) score += 0.3;
            if (s.tags?.some((t) => t.toLowerCase().includes(q))) score += 0.2;
            if (s.categories?.some((c) => c.toLowerCase().includes(q))) score += 0.1;
            if (score > 0) scored.push({ score, skill: s });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map((x) => x.skill);
    }

    /**
     * Match all skills whose `trigger` fires against the given input.
     * Strings are matched case-insensitively as substrings; RegExps are
     * tested as-is.
     */
    matchTriggers(input: string): SkillDefinition[] {
        const lower = input.toLowerCase();
        const out: SkillDefinition[] = [];
        for (const s of this._byName.values()) {
            if (!s.trigger) continue;
            if (typeof s.trigger === 'string') {
                if (lower.includes(s.trigger.toLowerCase())) out.push(s);
            } else if (s.trigger instanceof RegExp) {
                if (s.trigger.test(input)) out.push(s);
            }
        }
        return out;
    }
}
