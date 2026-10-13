FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
USER root
RUN mkdir /app && chown pwuser:pwuser /app
WORKDIR /app
USER pwuser
COPY --chown=pwuser:pwuser package*.json ./
RUN npm ci && node -e "if(require('playwright/package.json').version !== '1.63.0') process.exit(1)"
COPY --chown=pwuser:pwuser . .
CMD ["bash", "scripts/ci-tests.sh"]
