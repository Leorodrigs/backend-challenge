FROM localstack/localstack:4.14.0

COPY --chmod=755 init/*.sh /etc/localstack/init/ready.d/
RUN sed -i 's/\r$//' /etc/localstack/init/ready.d/*.sh
