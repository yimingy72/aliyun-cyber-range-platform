import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mainTf = fs.readFileSync(
  new URL('../infra/opentofu/modules/alicloud-enterprise-range/main.tf', import.meta.url),
  'utf8',
);
const outputsTf = fs.readFileSync(
  new URL('../infra/opentofu/modules/alicloud-enterprise-range/outputs.tf', import.meta.url),
  'utf8',
);
const moduleVariablesTf = fs.readFileSync(
  new URL('../infra/opentofu/modules/alicloud-enterprise-range/variables.tf', import.meta.url),
  'utf8',
);
const exampleVariablesTf = fs.readFileSync(
  new URL('../infra/opentofu/examples/alicloud-enterprise-range/variables.tf', import.meta.url),
  'utf8',
);
const rootWrapperTemplateTs = fs.readFileSync(
  new URL('../apps/api/src/provisioning/root-wrapper-template.ts', import.meta.url),
  'utf8',
);

test('enterprise range module does not inject a default host eip', () => {
  assert.equal(
    mainTf.includes('key              = "entry-default"'),
    false,
    'module should not auto-create a default host EIP when the template did not define one',
  );
});

test('enterprise range module tolerates templates without a host eip', () => {
  assert.match(
    outputsTf,
    /local\.resolved_entry_eip_key\s*!=\s*""\s*\?/,
    'public entry outputs should guard host EIP dependent fields behind an explicit EIP presence check',
  );
});

test('runtime selections variable accepts mixed fixed and auto policy objects', () => {
  const expectedTypeSnippet = /variable "runtime_selections" \{\s*type = object\(\{\s*image_policies\s*=\s*any\s*instance_type_policies\s*=\s*any\s*\}\)/s;

  assert.match(
    moduleVariablesTf,
    expectedTypeSnippet,
    'module variables should not constrain runtime selections with map(any), because mixed fixed/auto policy objects have different shapes',
  );
  assert.match(
    exampleVariablesTf,
    expectedTypeSnippet,
    'example root variables should use the same permissive runtime selections type as the module',
  );
  assert.match(
    rootWrapperTemplateTs,
    expectedTypeSnippet,
    'generated root wrapper should emit the same permissive runtime selections type to avoid tofu plan failures',
  );
});
