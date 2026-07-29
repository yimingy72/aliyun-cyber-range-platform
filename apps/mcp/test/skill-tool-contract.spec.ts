import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { createToolRegistry } from '../src/server';

const allScopes = [
  'templates:read',
  'templates:write',
  'templates:publish',
  'templates:delete',
  'images:read',
  'images:write',
  'ranges:read',
  'ranges:create',
  'ranges:write',
  'ranges:control',
  'ranges:destroy',
  'instances:read',
  'instances:create',
  'instances:destroy',
  'instances:control',
  'instances:credentials:read',
  'jobs:read',
  'users:read',
  'users:write',
  'billing:read',
  'billing:sync',
  'settings:read',
  'settings:write',
];

const skillRoot = resolve(process.cwd(), '../../skills');

const parameterTableFiles = [
  'SKILL.md',
  'references/products/image-center.md',
  'references/products/instance-management.md',
  'references/products/range-authoring.md',
  'references/products/range-instances.md',
  'references/products/user-management.md',
  'references/products/billing.md',
  'references/products/settings.md',
].map((relativePath) => resolve(skillRoot, relativePath));

const skillFiles = [
  ...parameterTableFiles,
  resolve(skillRoot, 'references/error-handling.md'),
  resolve(skillRoot, 'references/sensitive-outputs.md'),
];

type DocumentedParameters = {
  required: Set<string>;
  optional: Set<string>;
  conditional: Set<string>;
};

describe('Skill MCP parameter contract', () => {
  it('documents every runtime tool parameter in its correct category', () => {
    const documented = new Map<string, DocumentedParameters>();

    for (const filePath of parameterTableFiles) {
      collectDocumentedTools(readFileSync(filePath, 'utf8'), documented);
    }

    const tools = createToolRegistry({} as never).listTools(allScopes);
    expect(documented.size).toBe(tools.length);

    for (const tool of tools) {
      const parameters = documented.get(tool.name);
      expect(parameters, `${tool.name} is missing from the Skill tables`).toBeDefined();

      const schema = z.toJSONSchema(tool.inputSchema) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const required = new Set(schema.required ?? []);
      const optional = new Set(Object.keys(schema.properties ?? {}).filter((name) => !required.has(name)));

      expect([...parameters!.required].sort(), `${tool.name} required parameters`).toEqual([...required].sort());
      expect(
        [...new Set([...parameters!.optional, ...parameters!.conditional])].sort(),
        `${tool.name} optional or conditionally required parameters`,
      ).toEqual([...optional].sort());
    }
  });

  it('mentions only registered MCP tools throughout the Skill documentation', () => {
    const tools = createToolRegistry({} as never).listTools(allScopes);
    const registeredToolNames = new Set(tools.map((tool) => tool.name));

    for (const filePath of skillFiles) {
      const content = readFileSync(filePath, 'utf8');
      for (const match of content.matchAll(
        /`((?:platform|image|billing|range|single|admin|cloud|provision)_[a-z0-9_]+)`/g,
      )) {
        const toolName = match[1]!;
        expect(registeredToolNames, `${toolName} in ${filePath}`).toContain(toolName);
      }
    }
  });
});

function collectDocumentedTools(content: string, documented: Map<string, DocumentedParameters>) {
  let table: 'product' | 'shared' | null = null;

  for (const line of content.split('\n')) {
    if (line.startsWith('| 操作 | MCP 工具 | 必填参数 | 可选参数 |')) {
      table = 'product';
      continue;
    }

    if (line.startsWith('| 通用工具 | 必填参数 | Scope | 用途 |')) {
      table = 'shared';
      continue;
    }

    if (!line.startsWith('|')) {
      table = null;
      continue;
    }

    if (!table || line.startsWith('|---')) {
      continue;
    }

    const cells = splitTableRow(line);
    const toolCell = table === 'product' ? cells[1] : cells[0];
    const requiredCell = table === 'product' ? cells[2] : cells[1];
    const optionalCell = table === 'product' ? cells[3] : '';
    const toolName = toolCell.match(/`([^`]+)`/)?.[1];

    if (!toolName) {
      continue;
    }

    documented.set(toolName, {
      required: parameterNames(requiredCell, false),
      optional: parameterNames(optionalCell, false),
      conditional: parameterNames(requiredCell, true),
    });
  }
}

function splitTableRow(line: string) {
  return line
    .replaceAll('\\|', '__ESCAPED_PIPE__')
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.replaceAll('__ESCAPED_PIPE__', '|').trim());
}

function parameterNames(cell: string, conditional: boolean) {
  const normalizedCell = cell.replace(/默认(?:值)?(?:为)?\s*`[^`]+`/g, '');
  const isConditional = normalizedCell.trim().startsWith('至少一个');
  const names = new Set<string>();

  if (isConditional !== conditional) {
    return names;
  }

  for (const match of normalizedCell.matchAll(/`([^`]+)`/g)) {
    const parameterName = match[1]?.match(/^[A-Za-z][A-Za-z0-9]*/)?.[0];
    if (parameterName) {
      names.add(parameterName);
    }
  }

  if (normalizedCell.includes('操作元数据') && !normalizedCell.includes('不接受')) {
    names.add('idempotencyKey');
    names.add('confirmationId');
  }

  return names;
}
