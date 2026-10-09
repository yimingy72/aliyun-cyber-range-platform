FROM ghcr.io/opentofu/opentofu:1.13.1-minimal@sha256:dfbc3f0a8bed0adfa2cf49ff418f158afe24080eea6d6e748db8799fc4553db6 AS tofu
FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59
RUN sed -i 's|https://dl-cdn.alpinelinux.org/alpine|https://mirrors.aliyun.com/alpine|g' /etc/apk/repositories \
    && apk add --no-cache curl patch python3 zip
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu
ENV GOOS=linux GOARCH=amd64 CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOMEMLIMIT=3GiB GOGC=50 GOFLAGS=-p=1
WORKDIR /source
ENTRYPOINT ["sh", "/recipe/build-in-container.sh"]
