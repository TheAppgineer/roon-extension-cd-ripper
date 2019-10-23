FROM joelametta/whipper:release_v0.7.3

WORKDIR /home/worker

USER root

COPY cd-ripper.js LICENSE package.json /home/worker/

RUN apt-get --allow-releaseinfo-change update && \
    apt-get install -y --no-install-recommends git nodejs npm smbclient && \
    npm install && \
    apt-get autoremove -y git npm

# Override entrypoint of base image
ENTRYPOINT ["/usr/bin/env"]

CMD [ "node", "/home/worker", "/output" ]
