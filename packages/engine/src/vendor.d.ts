declare module "bpmn-moddle" {
  export default class BpmnModdle {
    constructor(packages?: Record<string, unknown>);
    // biome-ignore lint/suspicious/noExplicitAny: untyped library
    fromXML(xml: string, typeName?: string): Promise<{ rootElement: any; warnings: unknown[] }>;
  }
}

declare module "dmn-moddle" {
  export default class DmnModdle {
    constructor(packages?: Record<string, unknown>);
    // biome-ignore lint/suspicious/noExplicitAny: untyped library
    fromXML(xml: string, typeName?: string): Promise<{ rootElement: any; warnings: unknown[] }>;
  }
}

declare module "bpmnlint" {
  export class Linter {
    constructor(opts: { config: Record<string, unknown>; resolver: unknown });
    lint(root: unknown): Promise<Record<string, Array<{ id: string; message: string; category: string }>>>;
  }
}

declare module "bpmnlint/lib/resolver/node-resolver.js" {
  export default class NodeResolver {}
}
