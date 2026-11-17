FROM oven/bun:1

WORKDIR /app
COPY server/ ./server/
COPY web/ ./web/

# Tests are not needed at runtime.
RUN rm -f server/*.test.ts web/*.test.js \
 && mkdir -p /data && chown bun:bun /data

ENV PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
USER bun

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "server/main.ts"]
