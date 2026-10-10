FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59
RUN apk add --no-cache curl patch python3
ENV GOOS=linux GOARCH=amd64 CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2 GOMEMLIMIT=3GiB GOGC=50 GOFLAGS=-p=1
WORKDIR /source
ENTRYPOINT ["sh", "/recipe/build-in-container.sh"]
