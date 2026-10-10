ARG OPENTOFU_IMAGE=ghcr.io/opentofu/opentofu:1.13.1-minimal
FROM ${OPENTOFU_IMAGE} AS tofu
FROM node:22-alpine
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu
COPY infra/opentofu/modules/tencentcloud-single-instance-network /source/tencentcloud-single-instance-network
COPY infra/opentofu/modules/tencentcloud-single-instance-batch /source/tencentcloud-single-instance-batch
COPY infra/opentofu/modules/tencentcloud-enterprise-range /source/tencentcloud-enterprise-range
COPY scripts/docker/check-tencentcloud-provider-schema.cjs /source/check-tencentcloud-provider-schema.cjs
COPY scripts/docker/check-tencentcloud-range-update-plan.cjs /source/check-tencentcloud-range-update-plan.cjs
ENTRYPOINT ["/bin/sh"]
