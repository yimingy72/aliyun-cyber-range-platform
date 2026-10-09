from pathlib import Path

source = Path('/source')
original = Path('/tmp/original-instance.go').read_text()
patched = (source / 'alicloud/resource_alicloud_instance.go').read_text()
old = 'd.Timeout(schema.TimeoutCreate), 10*time.Second, ecsService.InstanceStateRefreshFunc(d.Id(), []string{"Stopping"}))'
assert original.count(old) == 1, 'Upstream create waiter changed; review the patch'
assert patched == original.replace(old, old.replace('10*time.Second', '2*time.Second')), 'Patch changed more than ECS create initial delay'
assert 'd.Timeout(schema.TimeoutDelete), 10*time.Second' in patched, 'Delete delay must remain unchanged'
common = (source / 'alicloud/common.go').read_text()
start = common.index('func BuildStateConf(')
helper = common[start:common.index('\n}', start) + 2]
assert 'MinTimeout: 3 * time.Second' in helper, 'Upstream polling backoff changed'
refresh = (source / 'alicloud/service_alicloud_ecs.go').read_text()
start = refresh.index('func (s *EcsService) InstanceStateRefreshFunc(')
refresh = refresh[start:refresh.index('\n}', start) + 2]
assert 'if NotFoundError(err)' in refresh and 'return nil, "", nil' in refresh, 'NotFound retry contract changed'
assert 'return nil, "", WrapError(err)' in refresh, 'Query errors must not be treated as success'
checks = source / 'fastwaitchecks'
checks.mkdir(exist_ok=True)
(checks / 'production.go').write_text('package fastwaitchecks\nimport ("time"; "github.com/hashicorp/terraform-plugin-sdk/helper/resource")\n' + helper + '\n')
(checks / 'waiter_test.go').write_text(Path('/recipe/waiter_test.go').read_text())
print('Source contract passed: only ECS creation delay differs; delete, polling, timeout and refresh retained')
