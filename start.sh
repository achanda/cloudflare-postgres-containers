#!/bin/bash
set -e

echo "=== Starting PostgreSQL + PostgREST Container ==="

# Verify PostgREST installation
echo "Verifying PostgREST installation..."
if [ -f "/usr/local/bin/postgrest" ]; then
    echo "PostgREST binary found at /usr/local/bin/postgrest"
    ls -la /usr/local/bin/postgrest
    echo "PostgREST version:"
    /usr/local/bin/postgrest --version
else
    echo "ERROR: PostgREST binary not found!"
    echo "Contents of /usr/local/bin:"
    ls -la /usr/local/bin/ || echo "Directory not accessible"
    exit 1
fi

# Verify PostgREST configuration
echo "Verifying PostgREST configuration..."
if [ -f "/etc/postgrest.conf" ]; then
    echo "PostgREST config found at /etc/postgrest.conf"
    cat /etc/postgrest.conf
else
    echo "ERROR: PostgREST config not found!"
    exit 1
fi

# Function to check if PostgreSQL is ready
check_postgres() {
    pg_isready -h localhost -p 5432 -U postgres > /dev/null 2>&1
}

# Function to check if PostgreSQL is accepting connections
check_postgres_connection() {
    psql -h localhost -p 5432 -U postgres -d postgres -c "SELECT 1;" > /dev/null 2>&1
}

# Function to check if PostgREST is responding
check_postgrest() {
    curl -s http://localhost:3000/ > /dev/null 2>&1
}

# Start PostgreSQL using the official entrypoint
echo "Starting PostgreSQL..."
docker-entrypoint.sh postgres &
POSTGRES_PID=$!

echo "PostgreSQL started with PID: $POSTGRES_PID"

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
TIMEOUT=120
COUNTER=0
while [ $COUNTER -lt $TIMEOUT ]; do
    if check_postgres; then
        echo "PostgreSQL is ready!"
        break
    fi
    echo "Waiting for PostgreSQL... ($COUNTER/$TIMEOUT)"
    sleep 2
    COUNTER=$((COUNTER + 2))
done

if [ $COUNTER -eq $TIMEOUT ]; then
    echo "ERROR: PostgreSQL failed to start within $TIMEOUT seconds"
    echo "Checking PostgreSQL status..."
    ps aux | grep postgres
    echo "Checking PostgreSQL logs..."
    find /var/lib/postgresql/data -name "*.log" -exec tail -n 20 {} \; 2>/dev/null || echo "No log files found"
    exit 1
fi

# Give PostgreSQL extra time to fully initialize
echo "Giving PostgreSQL extra time to fully initialize..."
sleep 10

# Wait for PostgreSQL to accept connections
echo "Waiting for PostgreSQL to accept connections..."
COUNTER=0
while [ $COUNTER -lt 60 ]; do
    if check_postgres_connection; then
        echo "PostgreSQL is accepting connections!"
        break
    fi
    echo "Waiting for PostgreSQL connections... ($COUNTER/60)"
    sleep 2
    COUNTER=$((COUNTER + 2))
done

if [ $COUNTER -eq 60 ]; then
    echo "ERROR: PostgreSQL is not accepting connections"
    exit 1
fi

# Start PostgREST
echo "Starting PostgREST..."
/usr/local/bin/postgrest /etc/postgrest.conf &
POSTGREST_PID=$!
echo "PostgREST started with PID: $POSTGREST_PID"

# Wait a moment for PostgREST to start
sleep 5

# Check if PostgREST is responding
echo "Checking if PostgREST is responding..."
COUNTER=0
while [ $COUNTER -lt 30 ]; do
    if check_postgrest; then
        echo "PostgREST is responding successfully!"
        break
    fi
    echo "Waiting for PostgREST to respond... ($COUNTER/30)"
    sleep 2
    COUNTER=$((COUNTER + 2))
done

if [ $COUNTER -eq 30 ]; then
    echo "WARNING: PostgREST may not be responding, but continuing..."
fi

echo "=== Both services are running ==="
echo "PostgreSQL PID: $POSTGRES_PID"
echo "PostgREST PID: $POSTGREST_PID"
echo "Container is ready!"

# Wait for either process to exit
wait -n $POSTGRES_PID $POSTGREST_PID
EXIT_CODE=$?
echo "Process exited with code: $EXIT_CODE"
exit $EXIT_CODE 