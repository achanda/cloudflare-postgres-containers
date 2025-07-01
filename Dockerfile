FROM postgres:15

# Install PostgREST and dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    wget \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Download and install PostgREST from specific version
RUN curl -L -o /tmp/postgrest.tar.xz https://github.com/PostgREST/postgrest/releases/download/v13.0.4/postgrest-v13.0.4-linux-static-x86-64.tar.xz \
    && echo "Download completed. File size: $(wc -c < /tmp/postgrest.tar.xz) bytes" \
    && tar -xJf /tmp/postgrest.tar.xz -C /tmp \
    && mv /tmp/postgrest /usr/local/bin/postgrest \
    && chmod +x /usr/local/bin/postgrest \
    && rm /tmp/postgrest.tar.xz \
    && echo "PostgREST installed successfully" \
    && ls -la /usr/local/bin/postgrest \
    && /usr/local/bin/postgrest --version

# Copy PostgREST configuration
COPY postgrest.conf /etc/postgrest.conf

# Copy initialization scripts
COPY init.sql /docker-entrypoint-initdb.d/

# Copy startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Expose PostgreSQL and PostgREST ports
EXPOSE 5432 3000

# Use the startup script
CMD ["/start.sh"]