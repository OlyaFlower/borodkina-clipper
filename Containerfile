# Local clipper: cuts a YouTube clip on the owner's Mac (home IP). Run with Apple's `container` or docker.
FROM debian:bookworm-slim
ARG DEBIAN_FRONTEND=noninteractive
LABEL org.opencontainers.image.source="https://github.com/OlyaFlower/borodkina-clipper"
LABEL org.opencontainers.image.description="Cuts a YouTube clip and encodes the carousel renditions"
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl jq unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/ /opt/clipper/scripts/
RUN chmod +x /opt/clipper/scripts/*.sh \
 && TOOLS_DIR=/usr/local/bin bash /opt/clipper/scripts/install-tools.sh ffmpeg yt-dlp deno \
 && ln -s /opt/clipper/scripts/clip.sh /usr/local/bin/clip \
 && useradd --create-home --uid 1000 clipper \
 && mkdir /out \
 && chown clipper /out
USER clipper
WORKDIR /out
ENTRYPOINT ["clip"]
