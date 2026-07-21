import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('iac runner package exposes build and test scripts', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL('../packages/iac-runner/package.json', import.meta.url), 'utf8'),
  );

  assert.equal(packageJson.name, '@aliyun-cyber-range/iac-runner');
  assert.equal(typeof packageJson.scripts.build, 'string');
  assert.equal(typeof packageJson.scripts.test, 'string');
  assert.match(packageJson.scripts.build, /\btsc\b/);
  assert.match(packageJson.scripts.test, /\bvitest run\b/);
});

test('opentofu module exposes the enterprise cyber range resources and outputs', () => {
  const providersTf = fs.readFileSync(
    new URL('../infra/opentofu/modules/alicloud-enterprise-range/providers.tf', import.meta.url),
    'utf8',
  );
  const mainTf = fs.readFileSync(
    new URL('../infra/opentofu/modules/alicloud-enterprise-range/main.tf', import.meta.url),
    'utf8',
  );
  const outputsTf = fs.readFileSync(
    new URL('../infra/opentofu/modules/alicloud-enterprise-range/outputs.tf', import.meta.url),
    'utf8',
  );

  assert.match(providersTf, /required_providers/);
  assert.match(providersTf, /aliyun\/alicloud/);
  assert.match(mainTf, /resource "alicloud_vpc"/);
  assert.match(mainTf, /resource "alicloud_vswitch" "zones"/);
  assert.match(mainTf, /resource "alicloud_security_group"/);
  assert.match(mainTf, /security_group_name/);
  assert.doesNotMatch(mainTf, /resource "alicloud_security_group" "range"[\s\S]*\n\s+name\s*=/);
  assert.match(mainTf, /resource "alicloud_security_group_rule"/);
  assert.match(mainTf, /resource "alicloud_instance" "hosts"/);
  assert.match(mainTf, /resource "alicloud_eip_address" "addresses"/);
  assert.match(mainTf, /resource "alicloud_eip_association" "host_targets"/);
  assert.match(outputsTf, /output "vpc_id"/);
  assert.match(outputsTf, /output "subnet_ids"/);
  assert.match(outputsTf, /output "host_ids"/);
  assert.match(outputsTf, /output "public_entry"/);
  assert.match(outputsTf, /output "resource_summary"/);
  assert.match(outputsTf, /resolved_image_ids/);
});

test('enterprise range module preserves each host image ID instead of using a shared image', () => {
  const mainTf = fs.readFileSync(
    new URL('../infra/opentofu/modules/alicloud-enterprise-range/main.tf', import.meta.url),
    'utf8',
  );
  const variablesTf = fs.readFileSync(
    new URL('../infra/opentofu/modules/alicloud-enterprise-range/variables.tf', import.meta.url),
    'utf8',
  );
  const rootWrapper = fs.readFileSync(
    new URL('../apps/api/src/provisioning/root-wrapper-template.ts', import.meta.url),
    'utf8',
  );

  assert.match(variablesTf, /variable "hosts"[\s\S]*image_id\s*=\s*optional\(string\)/);
  assert.match(rootWrapper, /variable "hosts"[\s\S]*image_id\s*=\s*optional\(string\)/);
  assert.match(
    mainTf,
    /resource "alicloud_instance" "hosts"[\s\S]*image_id\s*=\s*coalesce\(try\(each\.value\.image_id, null\), var\.image_id\)/,
  );
});

test('workspace scripts and examples expose the opentofu bootstrap flow', () => {
  const rootPackageJson = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const envExample = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const validateScript = fs.readFileSync(
    new URL('../scripts/dev/validate-opentofu-example.sh', import.meta.url),
    'utf8',
  );
  const exampleMainTf = fs.readFileSync(
    new URL('../infra/opentofu/examples/alicloud-enterprise-range/main.tf', import.meta.url),
    'utf8',
  );
  const exampleVariablesTf = fs.readFileSync(
    new URL('../infra/opentofu/examples/alicloud-enterprise-range/variables.tf', import.meta.url),
    'utf8',
  );
  const exampleTfvars = fs.readFileSync(
    new URL('../infra/opentofu/examples/alicloud-enterprise-range/range.auto.tfvars.example', import.meta.url),
    'utf8',
  );

  assert.equal(typeof rootPackageJson.scripts['iac:validate'], 'string');
  assert.match(rootPackageJson.scripts['iac:validate'], /validate-opentofu-example\.sh/);
  assert.match(envExample, /^ALICLOUD_ACCESS_KEY=/m);
  assert.match(envExample, /^ALICLOUD_SECRET_KEY=/m);
  assert.match(envExample, /^ALICLOUD_REGION=/m);
  assert.match(envExample, /^ALICLOUD_ZONE_ID=/m);
  assert.match(envExample, /^ALICLOUD_PROVIDER_ZIP_PATH=/m);
  assert.match(envExample, /^ALICLOUD_IMAGE_ID=/m);
  assert.match(envExample, /^ALICLOUD_INSTANCE_TYPE=auto$/m);
  assert.match(envExample, /^ALICLOUD_INSTANCE_TYPE_PREFERENCES=/m);
  assert.match(envExample, /^ALICLOUD_RANGE_VPC_CIDR=/m);
  assert.match(envExample, /^ALICLOUD_RANGE_DMZ_CIDR=/m);
  assert.match(envExample, /^ALICLOUD_RANGE_OFFICE_CIDR=/m);
  assert.match(envExample, /^ALICLOUD_RANGE_SERVER_CIDR=/m);
  assert.match(envExample, /^ALICLOUD_RANGE_DMZ_PRIVATE_IP=/m);
  assert.match(envExample, /^ALICLOUD_RANGE_OFFICE_PRIVATE_IP=/m);
  assert.match(envExample, /^ALICLOUD_RANGE_SERVER_PRIVATE_IP=/m);
  assert.match(validateScript, /docker image inspect "\$TOFU_IMAGE"/);
  assert.match(validateScript, /docker create "\$TOFU_IMAGE"/);
  assert.match(validateScript, /docker cp "\$container_id:\$TOFU_IMAGE_BINARY_PATH"/);
  assert.match(validateScript, /ALICLOUD_PROVIDER_ZIP_PATH="\$\{ALICLOUD_PROVIDER_ZIP_PATH:-\}"/);
  assert.match(validateScript, /TF_CLI_CONFIG_FILE/);
  assert.match(validateScript, /provider_installation \{/);
  assert.match(validateScript, /filesystem_mirror \{/);
  assert.match(validateScript, /registry\.opentofu\.org\/aliyun\/alicloud/);
  assert.match(validateScript, /-e HTTPS_PROXY/);
  assert.match(validateScript, /-e HTTP_PROXY/);
  assert.match(validateScript, /-e ALL_PROXY/);
  assert.match(validateScript, /-e https_proxy/);
  assert.match(validateScript, /-e http_proxy/);
  assert.match(validateScript, /-e all_proxy/);
  assert.match(validateScript, /SSL_CERT_FILE=\/etc\/ssl\/certs\/ca-certificates\.crt/);
  assert.match(validateScript, /-v "\$HOST_CERT_BUNDLE_PATH:\/etc\/ssl\/certs\/ca-certificates\.crt:ro"/);
  assert.match(validateScript, /-v "\$DOCKER_TMP_DIR:\/tmp"/);
  assert.match(validateScript, /cd "\$ROOT_DIR"/);
  assert.match(validateScript, /run_tofu_root fmt -check -recursive infra\/opentofu/);
  assert.match(validateScript, /infra\/opentofu\/examples\/alicloud-enterprise-range/);
  assert.match(validateScript, /run_tofu_in_example init -backend=false/);
  assert.match(validateScript, /run_tofu_in_example validate/);
  assert.match(envExample, /^OPENTOFU_INSTANCE_TYPE=auto$/m);
  assert.match(envExample, /^OPENTOFU_INSTANCE_TYPE_PREFERENCES=/m);
  assert.match(exampleMainTf, /module "range"/);
  assert.match(exampleMainTf, /source\s*=\s*"\.\.\/\.\.\/modules\/alicloud-enterprise-range"/);
  assert.match(exampleVariablesTf, /variable "access_key"/);
  assert.match(exampleVariablesTf, /variable "secret_key"/);
  assert.match(exampleTfvars, /resource_name_prefix/);
  assert.match(exampleTfvars, /dmz_cidr/);
  assert.match(exampleTfvars, /office_cidr/);
  assert.match(exampleTfvars, /server_cidr/);
  assert.match(exampleTfvars, /dmz_private_ip/);
  assert.match(exampleTfvars, /office_private_ip/);
  assert.match(exampleTfvars, /server_private_ip/);
  assert.match(exampleTfvars, /instance_password/);
});

test('workspace exposes a real-cloud smoke test entry for the enterprise range', () => {
  const rootPackageJson = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const smokeScript = fs.readFileSync(
    new URL('../scripts/dev/smoke-opentofu-enterprise-range.sh', import.meta.url),
    'utf8',
  );

  assert.equal(typeof rootPackageJson.scripts['iac:smoke'], 'string');
  assert.match(rootPackageJson.scripts['iac:smoke'], /smoke-opentofu-enterprise-range\.sh/);
  assert.match(smokeScript, /SMOKE_TFVARS_PATH=/);
  assert.match(smokeScript, /SMOKE_EXECUTION_MODE=/);
  assert.match(smokeScript, /run_tofu_in_example init/);
  assert.match(smokeScript, /run_tofu_in_example validate/);
  assert.match(smokeScript, /run_tofu_in_example plan/);
  assert.match(smokeScript, /--plan-only/);
  assert.match(smokeScript, /plan-only/);
  assert.match(smokeScript, /run_tofu_in_example apply -auto-approve/);
  assert.match(smokeScript, /run_tofu_in_example output -json/);
  assert.match(smokeScript, /run_tofu_in_example destroy -auto-approve/);
  assert.match(smokeScript, /DescribeAvailableResource/);
  assert.match(smokeScript, /state list/);
  assert.match(smokeScript, /trap cleanup EXIT/);
  assert.match(smokeScript, /ALICLOUD_ACCESS_KEY/);
  assert.match(smokeScript, /ALICLOUD_SECRET_KEY/);
  assert.match(smokeScript, /ALICLOUD_IMAGE_ID/);
  assert.match(smokeScript, /OPENTOFU_IMAGE_ID/);
  assert.match(smokeScript, /randomBytes/);
});
