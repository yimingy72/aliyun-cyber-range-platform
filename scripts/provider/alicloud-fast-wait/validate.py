import json
import os
from pathlib import Path
import subprocess
import tempfile

version = os.environ['ALICLOUD_PROVIDER_VERSION']
mirror = Path('/out/mirror')
validation = Path('/out/validation')
validation.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='provider-validation-') as work:
    directory = Path(work)
    config = directory / 'tofurc'
    config.write_text('provider_installation {\n filesystem_mirror {\n  path = ' + json.dumps(str(mirror)) + '\n }\n}\n')
    (directory / 'main.tf').write_text('''terraform {
  required_providers {
    alicloud = {
      source = "aliyun/alicloud"
      version = "= VERSION"
    }
  }
}
provider "alicloud" {
  region = "cn-hangzhou"
}
resource "alicloud_instance" "schema_check" {
  image_id = "schema-only-no-cloud-request"
  instance_type = "ecs.g7.large"
  security_groups = ["sg-schema-only"]
  vswitch_id = "vsw-schema-only"
  system_disk_category = "cloud_essd"
  system_disk_size = 40
  tags = { ExecutionBackend = "opentofu" }
  volume_tags = { ExecutionBackend = "opentofu" }
}
'''.replace('VERSION', version))
    env = {**os.environ, 'TF_CLI_CONFIG_FILE': str(config), 'TF_IN_AUTOMATION': 'true'}
    for name, args in [('init', ['init', '-backend=false', '-input=false', '-no-color']), ('validate', ['validate', '-no-color'])]:
        result = subprocess.run(['tofu', *args], cwd=directory, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (validation / f'{name}.log').write_text(result.stdout)
        print(result.stdout)
        result.check_returncode()
    with (validation / 'schema.json').open('w') as output:
        subprocess.run(['tofu', 'providers', 'schema', '-json'], cwd=directory, env=env, stdout=output, check=True)
    schemas = json.loads((validation / 'schema.json').read_text())
    resources = schemas['provider_schemas']['registry.opentofu.org/aliyun/alicloud']['resource_schemas']
    instance = resources['alicloud_instance']['block']['attributes']
    for attribute in ['system_disk_id', 'public_ip', 'private_ip', 'tags', 'volume_tags']:
        assert attribute in instance, f'Missing required schema: {attribute}'
    (validation / '.terraform.lock.hcl').write_text((directory / '.terraform.lock.hcl').read_text())
    summary = {'providerVersion': version, 'openTofuVersion': subprocess.check_output(['tofu', 'version'], text=True).splitlines()[0], 'init': 'passed', 'validate': 'passed', 'schema': 'passed', 'cloudCalls': 0, 'resourceSchemaCount': len(resources)}
    (validation / 'report.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary))
