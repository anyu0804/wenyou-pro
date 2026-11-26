/** 外部 JSON 的基础校验；各导入入口提供自己的错误文字。 */
export class JsonValidator {
  constructor(private message: (path: string, detail?: string) => string, private objectDetail?: string) {}

  fail(path: string, detail?: string): never {
    throw new Error(this.message(path, detail));
  }

  check(condition: unknown, path: string, detail?: string): asserts condition {
    if (!condition) this.fail(path, detail);
  }

  object(value: unknown, path: string): asserts value is Record<string, any> {
    this.check(value !== null && typeof value === 'object' && !Array.isArray(value), path, this.objectDetail);
  }
}

export const isText = (value: unknown): value is string => typeof value === 'string';
export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const isPoint = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
