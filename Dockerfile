FROM joelametta/whipper:release_v0.7.3

WORKDIR /home/worker

USER root
RUN apt-get update && \
    apt-get install -y git nodejs npm smbclient

COPY cd-ripper.js LICENSE package.json /home/worker/
RUN npm install

# Override entrypoint of base image
ENTRYPOINT ["/usr/bin/env"]

CMD [ "node", "/home/worker", "/output" ]
