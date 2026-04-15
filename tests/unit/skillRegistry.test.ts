import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../../src/skillRegistry';
import { SkillLifecycleManager } from '../../src/skillLifecycle';
import { SkillDefinition } from '../../src/types';

const make = (name: string, extra: Partial<SkillDefinition> = {}): SkillDefinition => ({
    name,
    description: `desc:${name}`,
    body: `body:${name}`,
    ...extra,
});

describe('SkillRegistry', () => {
    it('rejects duplicate names', () => {
        const r = new SkillRegistry([make('a')]);
        expect(() => r.register(make('a'))).toThrow(/already registered/);
    });

    it('indexes by category and tag', () => {
        const r = new SkillRegistry([
            make('py', { categories: ['lang'], tags: ['code'] }),
            make('go', { categories: ['lang'], tags: ['code', 'fast'] }),
            make('write', { categories: ['docs'], tags: ['prose'] }),
        ]);
        expect(r.listByCategory('lang').map((s) => s.name).sort()).toEqual(['go', 'py']);
        expect(r.listByTag('fast').map((s) => s.name)).toEqual(['go']);
        expect(r.listCategories().sort()).toEqual(['docs', 'lang']);
    });

    it('resolves dependencies topologically and breaks cycles', () => {
        const r = new SkillRegistry([
            make('a', { dependencies: ['b'] }),
            make('b', { dependencies: ['c'] }),
            make('c', { dependencies: ['a'] }), // cycle
        ]);
        const order = r.resolveDependencies('a').map((s) => s.name);
        expect(new Set(order)).toEqual(new Set(['a', 'b', 'c']));
        // 'a' must come last (deps resolve first), `c` first.
        expect(order[order.length - 1]).toBe('a');
    });

    it('search ranks name matches above description matches', () => {
        const r = new SkillRegistry([
            make('python', { description: 'general purpose' }),
            make('shell', { description: 'python-style scripting' }),
        ]);
        const hits = r.search('python');
        expect(hits[0].name).toBe('python');
        expect(hits.map((s) => s.name)).toContain('shell');
    });

    it('matchTriggers fires on string and regex triggers', () => {
        const r = new SkillRegistry([
            make('mr', { trigger: 'merge request' }),
            make('issue', { trigger: /\bissue\s+#\d+/ }),
            make('idle'),
        ]);
        expect(r.matchTriggers('open a Merge Request please').map((s) => s.name)).toEqual(['mr']);
        expect(r.matchTriggers('look at issue #42').map((s) => s.name)).toEqual(['issue']);
        expect(r.matchTriggers('hello').map((s) => s.name)).toEqual([]);
    });
});

describe('SkillLifecycleManager', () => {
    it('runs onLoad / onUnload hooks with shared context', async () => {
        const events: string[] = [];
        const r = new SkillRegistry([
            make('s1', {
                onLoad: (ctx) => { ctx.scratch.opened = true; events.push('load'); },
                onUnload: (ctx) => { events.push(`unload:${ctx.scratch.opened}`); },
            }),
        ]);
        const m = new SkillLifecycleManager({ registry: r });
        const r1 = await m.loadSkill('s1');
        expect(r1.success).toBe(true);
        expect(m.isLoaded('s1')).toBe(true);
        await m.unloadSkill('s1');
        expect(m.isLoaded('s1')).toBe(false);
        expect(events).toEqual(['load', 'unload:true']);
    });

    it('auto-loads dependencies and reports them', async () => {
        const r = new SkillRegistry([
            make('base'),
            make('app', { dependencies: ['base'] }),
        ]);
        const m = new SkillLifecycleManager({ registry: r });
        const r1 = await m.loadSkill('app');
        expect(r1.success).toBe(true);
        expect(r1.loadedDependencies).toEqual(['base']);
        expect(m.isLoaded('base')).toBe(true);
    });

    it('autoLoadFromTriggers loads matching skills exactly once', async () => {
        const r = new SkillRegistry([
            make('mr', { trigger: 'merge request' }),
            make('mr2', { trigger: 'merge request' }),
            make('quiet'),
        ]);
        const m = new SkillLifecycleManager({ registry: r });
        const first = await m.autoLoadFromTriggers('please open a merge request');
        expect(first.sort()).toEqual(['mr', 'mr2']);
        const second = await m.autoLoadFromTriggers('another merge request please');
        expect(second).toEqual([]); // already loaded
    });

    it('returns SKILL_NOT_FOUND for unknown names', async () => {
        const r = new SkillRegistry([make('a')]);
        const m = new SkillLifecycleManager({ registry: r });
        const out = await m.loadSkill('ghost');
        expect(out.success).toBe(false);
        expect(out.error).toBe('SKILL_NOT_FOUND');
    });

    it('getActiveSkillBodies returns currently-loaded skill content', async () => {
        const r = new SkillRegistry([make('a'), make('b')]);
        const m = new SkillLifecycleManager({ registry: r });
        await m.loadSkill('a');
        const bodies = m.getActiveSkillBodies();
        expect(bodies.map((b) => b.name)).toEqual(['a']);
        expect(bodies[0].body).toBe('body:a');
    });
});
