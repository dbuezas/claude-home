ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm libgcc libstdc++ ripgrep jq curl \
 && npm install -g @anthropic-ai/claude-code \
 && claude --version

WORKDIR /opt/server
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/*.mjs server/ui.html ./

COPY run.sh /run.sh
RUN chmod a+x /run.sh
CMD ["/run.sh"]
