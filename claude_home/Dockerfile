ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm libgcc libstdc++ ripgrep jq curl git python3 \
 && npm install -g @anthropic-ai/claude-code \
 && claude --version \
 && adduser -D -H -h /data/home -s /bin/sh claude \
 && mkdir -p /secure && chmod 700 /secure

WORKDIR /opt/server
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/*.mjs server/ui.html server/ptyrun.py agent-guide.md ./

COPY run.sh /run.sh
RUN chmod a+x /run.sh
CMD ["/run.sh"]
