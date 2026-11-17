FROM oven/bun:1

WORKDIR /app
COPY server/ ./server/
COPY web/ ./web/
COPY scripts/ ./scripts/

# The app icons are generated here and are not stored in git. Tests and the script itself
# are not needed at runtime.
RUN bun scripts/make-icons.ts \
 && rm -rf scripts server/*.test.ts web/*.test.js \
 && mkdir -p /data && chown bun:bun /data

ENV PORT=9958 DATA_DIR=/data
VOLUME /data
EXPOSE 9958
USER bun

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 9958) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "server/main.ts"]
