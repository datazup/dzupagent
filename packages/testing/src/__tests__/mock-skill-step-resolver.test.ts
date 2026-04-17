import { describe, it, expect, beforeEach } from 'vitest';
import { MockSkillStepResolver } from '../mock-skill-step-resolver.js';
import type { MockCall } from '../mock-skill-step-resolver.js';

describe('MockSkillStepResolver', () => {
  let sut: MockSkillStepResolver;

  beforeEach(() => {
    sut = new MockSkillStepResolver();
  });

  // -------------------------------------------------------------------------
  // registerText
  // -------------------------------------------------------------------------

  describe('registerText', () => {
    it('should register a skill that returns { [skillId]: output }', async () => {
      sut.registerText('greet', 'hello');
      const step = await sut.resolve('greet');
      const result = await step.execute({});
      expect(result).toEqual({ greet: 'hello' });
    });

    it('should return consistent output across multiple executions', async () => {
      sut.registerText('echo', 'fixed');
      const step = await sut.resolve('echo');
      const r1 = await step.execute({});
      const r2 = await step.execute({});
      expect(r1).toEqual(r2);
    });

    it('should ignore the input state and always return the fixed output', async () => {
      sut.registerText('static', 'value');
      const step = await sut.resolve('static');
      const result = await step.execute({ foo: 'bar', nested: { x: 1 } });
      expect(result).toEqual({ static: 'value' });
    });

    it('should handle empty string output', async () => {
      sut.registerText('empty', '');
      const step = await sut.resolve('empty');
      const result = await step.execute({});
      expect(result).toEqual({ empty: '' });
    });

    it('should handle output with special characters', async () => {
      const special = 'line1\nline2\ttab "quotes" \'single\' `backtick`';
      sut.registerText('special', special);
      const step = await sut.resolve('special');
      const result = await step.execute({});
      expect(result).toEqual({ special });
    });

    it('should handle unicode output', async () => {
      const unicode = 'Hello \u{1F600} \u{1F30D} \u00E9\u00E8\u00EA';
      sut.registerText('unicode', unicode);
      const step = await sut.resolve('unicode');
      const result = await step.execute({});
      expect(result).toEqual({ unicode });
    });
  });

  // -------------------------------------------------------------------------
  // register (custom function)
  // -------------------------------------------------------------------------

  describe('register', () => {
    it('should register a synchronous transform function', async () => {
      sut.register('double', (state) => ({
        value: (state['n'] as number) * 2,
      }));
      const step = await sut.resolve('double');
      const result = await step.execute({ n: 5 });
      expect(result).toEqual({ value: 10 });
    });

    it('should register an async transform function', async () => {
      sut.register('async-op', async (state) => {
        return { processed: true, input: state['data'] };
      });
      const step = await sut.resolve('async-op');
      const result = await step.execute({ data: 'test' });
      expect(result).toEqual({ processed: true, input: 'test' });
    });

    it('should receive state from the execute call', async () => {
      let receivedState: Record<string, unknown> = {};
      sut.register('capture', (state) => {
        receivedState = state;
        return { ok: true };
      });
      const step = await sut.resolve('capture');
      await step.execute({ key: 'val', num: 42 });
      expect(receivedState).toEqual({ key: 'val', num: 42 });
    });

    it('should handle function that returns empty object', async () => {
      sut.register('empty', () => ({}));
      const step = await sut.resolve('empty');
      const result = await step.execute({});
      expect(result).toEqual({});
    });

    it('should overwrite a previously registered skill with same ID', async () => {
      sut.registerText('overwrite', 'first');
      sut.register('overwrite', () => ({ overwrite: 'second' }));
      const step = await sut.resolve('overwrite');
      const result = await step.execute({});
      expect(result).toEqual({ overwrite: 'second' });
    });
  });

  // -------------------------------------------------------------------------
  // registerError
  // -------------------------------------------------------------------------

  describe('registerError', () => {
    it('should throw the provided Error instance', async () => {
      const err = new Error('test failure');
      sut.registerError('failing', err);
      const step = await sut.resolve('failing');
      await expect(step.execute({})).rejects.toThrow('test failure');
    });

    it('should wrap a string into an Error', async () => {
      sut.registerError('failing-str', 'string error');
      const step = await sut.resolve('failing-str');
      await expect(step.execute({})).rejects.toThrow('string error');
    });

    it('should throw an instance of Error when given a string', async () => {
      sut.registerError('err-type', 'msg');
      const step = await sut.resolve('err-type');
      try {
        await step.execute({});
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toBe('msg');
      }
    });

    it('should preserve the original Error object when given an Error', async () => {
      class CustomError extends Error {
        code = 'CUSTOM';
      }
      const err = new CustomError('custom');
      sut.registerError('custom-err', err);
      const step = await sut.resolve('custom-err');
      try {
        await step.execute({});
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBe(err);
        expect((e as CustomError).code).toBe('CUSTOM');
      }
    });

    it('should throw regardless of input state', async () => {
      sut.registerError('always-fail', 'boom');
      const step = await sut.resolve('always-fail');
      await expect(step.execute({ any: 'state' })).rejects.toThrow('boom');
    });
  });

  // -------------------------------------------------------------------------
  // registerDelay
  // -------------------------------------------------------------------------

  describe('registerDelay', () => {
    it('should return the output after a delay', async () => {
      sut.registerDelay('slow', 10, 'done');
      const step = await sut.resolve('slow');
      const start = Date.now();
      const result = await step.execute({});
      const elapsed = Date.now() - start;
      expect(result).toEqual({ slow: 'done' });
      expect(elapsed).toBeGreaterThanOrEqual(5); // allow some timing slack
    });

    it('should work with zero delay', async () => {
      sut.registerDelay('instant', 0, 'immediate');
      const step = await sut.resolve('instant');
      const result = await step.execute({});
      expect(result).toEqual({ instant: 'immediate' });
    });

    it('should return { [skillId]: output } format', async () => {
      sut.registerDelay('keyed', 1, 'val');
      const step = await sut.resolve('keyed');
      const result = await step.execute({});
      expect(Object.keys(result as Record<string, unknown>)).toEqual(['keyed']);
    });
  });

  // -------------------------------------------------------------------------
  // unregister
  // -------------------------------------------------------------------------

  describe('unregister', () => {
    it('should remove a registered skill', () => {
      sut.registerText('temp', 'val');
      expect(sut.canResolve('temp')).toBe(true);
      sut.unregister('temp');
      expect(sut.canResolve('temp')).toBe(false);
    });

    it('should not throw when unregistering a non-existent skill', () => {
      expect(() => sut.unregister('nonexistent')).not.toThrow();
    });

    it('should cause resolve to throw after unregistering', async () => {
      sut.registerText('removable', 'val');
      sut.unregister('removable');
      await expect(sut.resolve('removable')).rejects.toThrow(
        'MockSkillStepResolver: skill "removable" not registered',
      );
    });
  });

  // -------------------------------------------------------------------------
  // resolve
  // -------------------------------------------------------------------------

  describe('resolve', () => {
    it('should throw for an unregistered skill ID', async () => {
      await expect(sut.resolve('unknown')).rejects.toThrow(
        'MockSkillStepResolver: skill "unknown" not registered',
      );
    });

    it('should return a WorkflowStep with the correct id', async () => {
      sut.registerText('my-skill', 'output');
      const step = await sut.resolve('my-skill');
      expect(step.id).toBe('my-skill');
    });

    it('should return a WorkflowStep with a description containing the skill id', async () => {
      sut.registerText('described', 'val');
      const step = await sut.resolve('described');
      expect(step.description).toContain('described');
    });

    it('should return a WorkflowStep with an execute function', async () => {
      sut.registerText('exec-check', 'val');
      const step = await sut.resolve('exec-check');
      expect(typeof step.execute).toBe('function');
    });

    it('should handle null/undefined input gracefully', async () => {
      sut.registerText('null-input', 'val');
      const step = await sut.resolve('null-input');
      // The execute receives null which gets coalesced to {}
      const result = await step.execute(null);
      expect(result).toEqual({ 'null-input': 'val' });
    });

    it('should handle undefined input gracefully', async () => {
      sut.registerText('undef-input', 'val');
      const step = await sut.resolve('undef-input');
      const result = await step.execute(undefined);
      expect(result).toEqual({ 'undef-input': 'val' });
    });
  });

  // -------------------------------------------------------------------------
  // canResolve
  // -------------------------------------------------------------------------

  describe('canResolve', () => {
    it('should return true for a registered skill', () => {
      sut.registerText('exists', 'val');
      expect(sut.canResolve('exists')).toBe(true);
    });

    it('should return false for an unregistered skill', () => {
      expect(sut.canResolve('nope')).toBe(false);
    });

    it('should return true after register()', () => {
      sut.register('fn-skill', () => ({}));
      expect(sut.canResolve('fn-skill')).toBe(true);
    });

    it('should return true after registerError()', () => {
      sut.registerError('err-skill', 'err');
      expect(sut.canResolve('err-skill')).toBe(true);
    });

    it('should return true after registerDelay()', () => {
      sut.registerDelay('delay-skill', 10, 'val');
      expect(sut.canResolve('delay-skill')).toBe(true);
    });

    it('should return false after unregister()', () => {
      sut.registerText('temp', 'val');
      sut.unregister('temp');
      expect(sut.canResolve('temp')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // calls tracking
  // -------------------------------------------------------------------------

  describe('calls tracking', () => {
    it('should start with an empty calls array', () => {
      expect(sut.calls).toEqual([]);
    });

    it('should record a call when execute is invoked', async () => {
      sut.registerText('tracked', 'val');
      const step = await sut.resolve('tracked');
      await step.execute({ a: 1 });
      expect(sut.calls).toHaveLength(1);
      expect(sut.calls[0]).toEqual({ skillId: 'tracked', state: { a: 1 } });
    });

    it('should record multiple calls in order', async () => {
      sut.registerText('skill-a', 'a');
      sut.registerText('skill-b', 'b');
      const stepA = await sut.resolve('skill-a');
      const stepB = await sut.resolve('skill-b');
      await stepA.execute({ x: 1 });
      await stepB.execute({ y: 2 });
      await stepA.execute({ x: 3 });
      expect(sut.calls).toHaveLength(3);
      expect(sut.calls[0]!.skillId).toBe('skill-a');
      expect(sut.calls[1]!.skillId).toBe('skill-b');
      expect(sut.calls[2]!.skillId).toBe('skill-a');
    });

    it('should snapshot the state (not keep a reference)', async () => {
      sut.registerText('snapshot', 'val');
      const step = await sut.resolve('snapshot');
      const state = { mutable: 'original' };
      await step.execute(state);
      state.mutable = 'modified';
      expect(sut.calls[0]!.state).toEqual({ mutable: 'original' });
    });

    it('should record call even when the skill throws', async () => {
      sut.registerError('err-tracked', 'boom');
      const step = await sut.resolve('err-tracked');
      try {
        await step.execute({ before: 'error' });
      } catch {
        // expected
      }
      expect(sut.calls).toHaveLength(1);
      expect(sut.calls[0]!.skillId).toBe('err-tracked');
      expect(sut.calls[0]!.state).toEqual({ before: 'error' });
    });

    it('should use empty object for null input in call recording', async () => {
      sut.registerText('null-call', 'val');
      const step = await sut.resolve('null-call');
      await step.execute(null);
      // null is coalesced to {} by the ?? operator, so spread of {} is {}
      expect(sut.calls[0]!.state).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Multiple skills and isolation
  // -------------------------------------------------------------------------

  describe('multiple skills and isolation', () => {
    it('should support many registered skills simultaneously', async () => {
      for (let i = 0; i < 20; i++) {
        sut.registerText(`skill-${i}`, `output-${i}`);
      }
      for (let i = 0; i < 20; i++) {
        expect(sut.canResolve(`skill-${i}`)).toBe(true);
        const step = await sut.resolve(`skill-${i}`);
        const result = await step.execute({});
        expect(result).toEqual({ [`skill-${i}`]: `output-${i}` });
      }
    });

    it('should isolate different resolver instances', async () => {
      const other = new MockSkillStepResolver();
      sut.registerText('shared-name', 'from-sut');
      other.registerText('shared-name', 'from-other');

      const stepSut = await sut.resolve('shared-name');
      const stepOther = await other.resolve('shared-name');

      expect(await stepSut.execute({})).toEqual({ 'shared-name': 'from-sut' });
      expect(await stepOther.execute({})).toEqual({ 'shared-name': 'from-other' });
      expect(sut.calls).toHaveLength(1);
      expect(other.calls).toHaveLength(1);
    });
  });
});
