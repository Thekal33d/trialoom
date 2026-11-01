# Trusted toolchain construction only; workloads execute later with network=none.
# The builder supplies the inspected immutable digest of the official Node image.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY playwright-core /opt/trialoom/node_modules/playwright-core
RUN node /opt/trialoom/node_modules/playwright-core/cli.js install-deps chromium && rm -rf /var/lib/apt/lists/*
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node /opt/trialoom/node_modules/playwright-core/cli.js install --only-shell chromium
COPY fixture.mjs /opt/trialoom/fixture.mjs
COPY fixture /opt/trialoom/fixture
COPY browser.mjs /opt/trialoom/browser.mjs
RUN mkdir /rootfs-probe && chmod 0777 /rootfs-probe
WORKDIR /opt/trialoom
USER 65534:65534
ENTRYPOINT ["/usr/bin/timeout", "--signal=KILL", "45s", "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/scratch", "TMPDIR=/scratch", "XDG_CACHE_HOME=/scratch", "UV_USE_IO_URING=0", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", "node", "/opt/trialoom/browser.mjs"]
