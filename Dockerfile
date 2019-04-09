FROM joelametta/whipper:release_v0.7.3

WORKDIR /home/worker

COPY cd-ripper.js LICENSE package.json /home/worker/

USER root
RUN apt-get update && \
    apt-get install -y git nodejs npm smbclient && \
    npm install

ENV PATH=$PATH:/whipper

# Override entrypoint of base image
ENTRYPOINT ["/usr/bin/env"]

USER worker
CMD [ "node", "/home/worker", "/output" ]
