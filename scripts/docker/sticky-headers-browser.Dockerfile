FROM node:22-alpine
RUN sed -i 's|https://dl-cdn.alpinelinux.org/alpine|https://mirrors.aliyun.com/alpine|g' /etc/apk/repositories \
  && apk add --no-cache chromium font-noto-cjk \
  && npm install --prefix /opt/browser --no-package-lock --registry=https://registry.npmmirror.com playwright-core@1.64.1
ENV NODE_PATH=/opt/browser/node_modules
WORKDIR /test
COPY scripts/docker/check-sticky-table-headers.cjs /test/check-sticky-table-headers.cjs
CMD ["node", "/test/check-sticky-table-headers.cjs"]
