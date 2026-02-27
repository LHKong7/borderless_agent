/**
 * skillsCore.ts - Skill loading and management.
 *
 * Loads skills from SKILL.md files or from a SkillStore.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SKILLS_DIR } from './config';

// ---------------------------------------------------------------------------
// SkillStore interface (optional injection)
// ---------------------------------------------------------------------------

export interface SkillStore {
    listSkills(): string[];
    getSkill(name: string): Record<string, any> | null;
}

// ---------------------------------------------------------------------------
// SkillLoader
// ---------------------------------------------------------------------------

export class SkillLoader {
    skillsDir: string;
    private _store: SkillStore | null;
    skills: Record<string, Record<string, any>> = {};

    constructor(skillsDir?: string, store?: SkillStore | null) {
        this.skillsDir = skillsDir ?? SKILLS_DIR;
        this._store = store ?? null;
        if (!this._store) {
            this.loadSkills();
        }
    }

    setStore(store: SkillStore | null): void {
        this._store = store;
        if (store) {
            this.skills = {};
        } else {
            this.loadSkills();
        }
    }

    parseSkillMd(filePath: string): Record<string, any> | null {
        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return null;
        }

        const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
        if (!match) return null;

        const [, frontmatter, body] = match;
        const metadata: Record<string, string> = {};
        for (const line of frontmatter.trim().split('\n')) {
            const colonIndex = line.indexOf(':');
            if (colonIndex >= 0) {
                const key = line.slice(0, colonIndex).trim();
                const value = line
                    .slice(colonIndex + 1)
                    .trim()
                    .replace(/^["']|["']$/g, '');
                metadata[key] = value;
            }
        }

        if (!metadata.name || !metadata.description) return null;

        return {
            name: metadata.name,
            description: metadata.description,
            body: body.trim(),
            path: filePath,
            dir: path.dirname(filePath),
        };
    }

    loadSkills(): void {
        if (!fs.existsSync(this.skillsDir)) return;

        const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillMd = path.join(this.skillsDir, entry.name, 'SKILL.md');
            if (!fs.existsSync(skillMd)) continue;
            const skill = this.parseSkillMd(skillMd);
            if (skill) {
                this.skills[skill.name] = skill;
            }
        }
    }

    getDescriptions(): string {
        if (this._store) {
            const names = this._store.listSkills();
            if (!names.length) return '(no skills available)';
            return names
                .map((name) => {
                    const skill = this._store!.getSkill(name);
                    const desc = skill?.description ?? '';
                    return `- ${name}: ${desc}`;
                })
                .join('\n');
        }
        if (!Object.keys(this.skills).length) return '(no skills available)';
        return Object.entries(this.skills)
            .map(([name, skill]) => `- ${name}: ${skill.description}`)
            .join('\n');
    }

    getSkillContent(name: string): string | null {
        if (this._store) {
            const skill = this._store.getSkill(name);
            if (!skill) return null;
            let content = `# Skill: ${skill.name}\n\n${skill.body ?? ''}`;
            const resources: string[] = [];
            if (Array.isArray(skill.resources)) {
                for (const r of skill.resources) resources.push(String(r));
            } else if (skill.dir) {
                for (const [folder, label] of [
                    ['scripts', 'Scripts'],
                    ['references', 'References'],
                    ['assets', 'Assets'],
                ] as const) {
                    const folderPath = path.join(String(skill.dir), folder);
                    if (fs.existsSync(folderPath)) {
                        const files = fs.readdirSync(folderPath);
                        if (files.length) {
                            resources.push(`${label}: ${files.join(', ')}`);
                        }
                    }
                }
            }
            if (resources.length) {
                content += '\n\n**Available resources:**\n';
                content += resources.map((r) => `- ${r}`).join('\n');
            }
            return content;
        }

        const skill = this.skills[name];
        if (!skill) return null;
        let content = `# Skill: ${skill.name}\n\n${skill.body}`;
        const resources: string[] = [];
        for (const [folder, label] of [
            ['scripts', 'Scripts'],
            ['references', 'References'],
            ['assets', 'Assets'],
        ] as const) {
            const folderPath = path.join(skill.dir, folder);
            if (fs.existsSync(folderPath)) {
                const files = fs.readdirSync(folderPath);
                if (files.length) {
                    resources.push(`${label}: ${files.join(', ')}`);
                }
            }
        }
        if (resources.length) {
            content += `\n\n**Available resources in ${skill.dir}:**\n`;
            content += resources.map((r) => `- ${r}`).join('\n');
        }
        return content;
    }

    listSkills(): string[] {
        if (this._store) return this._store.listSkills();
        return Object.keys(this.skills);
    }
}

// Global instance
export const SKILLS = new SkillLoader(SKILLS_DIR);
