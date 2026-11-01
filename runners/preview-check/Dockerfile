# Offline derivative of the previously verified immutable browser image.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY runners /opt/trialoom/runners
COPY src /opt/trialoom/src
COPY ipaddr.js /opt/trialoom/node_modules/ipaddr.js
WORKDIR /opt/trialoom
USER 65534:65534
ENTRYPOINT ["/usr/bin/timeout", "--signal=KILL", "70s", "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/scratch", "TMPDIR=/scratch", "XDG_CACHE_HOME=/scratch", "UV_USE_IO_URING=0", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", "node"]
