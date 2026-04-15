import { describe, it, expect } from 'vitest';
import { SourceRegistry, ContextBuilder } from '../../src/contextBuilder';

describe('SourceRegistry.assemble', () => {
    it('orders sources by priority desc', () => {
        const r = new SourceRegistry();
        r.register({ name: 'low', content: 'L', priority: 0.2, category: 'instruction' });
        r.register({ name: 'high', content: 'H', priority: 1.0, category: 'system' });
        r.register({ name: 'mid', content: 'M', priority: 0.5, category: 'preferences' });
        const out = r.assemble(10000);
        const idx = (s: string) => out.text.indexOf(s);
        expect(idx('H')).toBeLessThan(idx('M'));
        expect(idx('M')).toBeLessThan(idx('L'));
    });

    it('drops low-priority sources when budget is exhausted', () => {
        const r = new SourceRegistry();
        const big = 'x'.repeat(900); // ~300 tokens
        r.register({ name: 'system', content: big, priority: 1.0, category: 'system' });
        r.register({ name: 'extra', content: big, priority: 0.3, category: 'instruction' });
        // Budget enough for system only (~300 tokens, with small overhead).
        const out = r.assemble(320);
        expect(out.included).toContain('system');
        expect(out.dropped).toContain('extra');
    });

    it('truncates high-priority sources rather than dropping them', () => {
        const r = new SourceRegistry();
        const big = 'y'.repeat(3000); // ~1000 tokens
        r.register({ name: 'system', content: 'sys', priority: 1.0, category: 'system' });
        r.register({ name: 'project', content: big, priority: 0.85, category: 'project' });
        const out = r.assemble(200);
        expect(out.truncated).toContain('project');
        expect(out.text).toContain('truncated');
    });

    it('overwrites when registering the same name twice', () => {
        const r = new SourceRegistry();
        r.register({ name: 'x', content: 'first', priority: 0.5, category: 'system' });
        r.register({ name: 'x', content: 'second', priority: 0.5, category: 'system' });
        expect(r.list()).toHaveLength(1);
        expect(r.get('x')!.content).toBe('second');
    });

    it('renders skill blocks with their custom title when provided', () => {
        const r = new SourceRegistry();
        r.register({ name: 'system', content: 'base', priority: 1.0, category: 'system' });
        r.register({
            name: 'skill:py',
            content: 'use type hints',
            priority: 0.8,
            category: 'skill',
            title: '**Loaded skill: py**',
        });
        const out = r.assemble(10000);
        expect(out.text).toContain('**Loaded skill: py**');
        expect(out.text).toContain('use type hints');
    });
});

describe('ContextBuilder', () => {
    it('always includes the base system prompt at top', async () => {
        const cb = new ContextBuilder({ baseSystemPrompt: 'You are X.' });
        const r = await cb.build('hello', 10000);
        expect(r.text.startsWith('You are X.')).toBe(true);
    });

    it('injects active skills under the system prompt', async () => {
        const cb = new ContextBuilder({
            baseSystemPrompt: 'sys',
            activeSkills: [{ name: 'py', body: 'python tips' }],
        });
        const r = await cb.build('q', 10000);
        expect(r.text).toContain('Loaded skill: py');
        expect(r.text).toContain('python tips');
    });
});
