import { Container, loadBalance, getContainer } from "@cloudflare/containers";
import { Hono } from "hono";

export class PostgrestContainer extends Container {
  // Port the container listens on (PostgREST runs on 3000)
  defaultPort = 3000;
  // Time before container sleeps due to inactivity (increased from 5m to 15m)
  sleepAfter = "15m";
  // Maximum time a container can run before being recycled (default: 1h)
  maxLifetime = "2h";
  // Timeout for container startup
  startupTimeout = "10m";
  // Timeout for container shutdown
  shutdownTimeout = "1m";
  // Health check configuration
  healthCheck = {
    path: "/",
    interval: "10s",
    timeout: "5s",
    retries: 30,
  };
  // Environment variables passed to the container
  envVars = {
    POSTGRES_PASSWORD: "postgres",
    POSTGRES_DB: "postgres",
  };

  // Optional lifecycle hooks
  override onStart() {
    console.log("PostgreSQL + PostgREST container successfully started");
  }

  override onStop() {
    console.log("PostgreSQL + PostgREST container successfully shut down");
  }

  override onError(error: unknown) {
    console.log("PostgreSQL + PostgREST container error:", error);
  }
}

// Create Hono app with proper typing for Cloudflare Workers
const app = new Hono<{
  Bindings: { POSTGREST_CONTAINER: DurableObjectNamespace<PostgrestContainer> };
}>();

// Home route with available endpoints
app.get("/", (c) => {
  return c.text(
    "PostgreSQL + PostgREST API\n\n" +
      "Available endpoints:\n" +
      "GET /api/users - Get all users\n" +
      "GET /api/users/:id - Get user by ID\n" +
      "POST /api/users - Create a new user\n" +
      "PUT /api/users/:id - Update user\n" +
      "DELETE /api/users/:id - Delete user\n\n" +
      "GET /api/posts - Get all posts\n" +
      "GET /api/posts/:id - Get post by ID\n" +
      "POST /api/posts - Create a new post\n" +
      "PUT /api/posts/:id - Update post\n" +
      "DELETE /api/posts/:id - Delete post\n\n" +
      "GET /api/health - Health check\n" +
      "GET /api/schema - Get database schema\n"
  );
});

// Wrapper function for container operations with proper error handling
async function withContainerTimeout<T>(
  containerNamespace: DurableObjectNamespace<PostgrestContainer>, 
  name: string, 
  operation: (container: any) => Promise<T>
): Promise<T> {
  try {
    const container = await getContainerWithTimeout(containerNamespace, name);
    return await operation(container);
  } catch (error) {
    console.error(`Container operation failed for ${name}:`, error);
    throw error;
  }
}

// Helper function to get container with timeout and retry logic
async function getContainerWithTimeout(containerNamespace: DurableObjectNamespace<PostgrestContainer>, name: string) {
  const container = getContainer(containerNamespace, name);
  
  // Add a timeout wrapper to prevent blockConcurrencyWhile from hanging
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Container operation timed out')), 240000); // 4 minute timeout
  });
  
  try {
    // Try to connect to the container with retries
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Attempting to connect to container ${name} (attempt ${attempt}/3)`);
        
        // Race between the container operation and the timeout
        await Promise.race([
          container.fetch(new Request('http://localhost:3000/')),
          timeoutPromise
        ]);
        
        console.log(`Successfully connected to container ${name}`);
        return container;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.log(`Attempt ${attempt} failed for container ${name}:`, lastError.message);
        
        if (attempt < 3) {
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
        }
      }
    }
    
    throw lastError || new Error('Container connection failed after 3 attempts');
  } catch (error) {
    console.error(`Container ${name} not ready or timed out:`, error);
    throw error;
  }
}

// Helper function to get container and make request
async function makePostgrestRequest(container: any, path: string, method: string = "GET", body?: any) {
  const url = `http://localhost:3000${path}`;
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    // Add timeout configuration
    signal: AbortSignal.timeout(300000), // 5 minute timeout (300 seconds)
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await container.fetch(new Request(url, options));
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request timed out after 5 minutes');
    }
    throw error;
  }
}

// Health check endpoint
app.get("/api/health", async (c) => {
  try {
    const container = await getContainerWithTimeout(c.env.POSTGREST_CONTAINER, "health-check");
    const response = await makePostgrestRequest(container, "/");
    if (response.ok) {
      return c.json({ status: "healthy", message: "PostgreSQL + PostgREST is running" });
    } else {
      return c.json({ status: "unhealthy", error: "PostgREST not responding" }, 503);
    }
  } catch (error) {
    console.error("Health check error:", error);
    return c.json({ 
      status: "error", 
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// Get database schema
app.get("/api/schema", async (c) => {
  try {
    return await withContainerTimeout(c.env.POSTGREST_CONTAINER, "schema", async (container) => {
      return await makePostgrestRequest(container, "/");
    });
  } catch (error) {
    return c.json({ 
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// Users endpoints
app.get("/api/users", async (c) => {
  const container = getContainer(c.env.POSTGREST_CONTAINER, "users");
  try {
    const response = await makePostgrestRequest(container, "/users");
    return response;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

app.get("/api/users/:id", async (c) => {
  const id = c.req.param("id");
  const container = getContainer(c.env.POSTGREST_CONTAINER, `user-${id}`);
  try {
    const response = await makePostgrestRequest(container, `/users?id=eq.${id}`);
    return response;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

app.post("/api/users", async (c) => {
  const body = await c.req.json();
  const container = getContainer(c.env.POSTGREST_CONTAINER, "create-user");
  try {
    const response = await makePostgrestRequest(container, "/users", "POST", body);
    return response;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

app.put("/api/users/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const container = getContainer(c.env.POSTGREST_CONTAINER, `update-user-${id}`);
  try {
    const response = await makePostgrestRequest(container, `/users?id=eq.${id}`, "PATCH", body);
    return response;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

app.delete("/api/users/:id", async (c) => {
  const id = c.req.param("id");
  const container = getContainer(c.env.POSTGREST_CONTAINER, `delete-user-${id}`);
  try {
    const response = await makePostgrestRequest(container, `/users?id=eq.${id}`, "DELETE");
    return response;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

// Posts endpoints
app.get("/api/posts", async (c) => {
  const container = getContainer(c.env.POSTGREST_CONTAINER, "posts");
  try {
    const response = await makePostgrestRequest(container, "/posts");
    return response;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

app.get("/api/posts/:id", async (c) => {
  const id = c.req.param("id");
  const container = getContainer(c.env.POSTGREST_CONTAINER, `post-${id}`);
  try {
    const response = await makePostgrestRequest(container, `/posts?id=eq.${id}`);
    return response;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

app.post("/api/posts", async (c) => {
  const body = await c.req.json();
  const container = getContainer(c.env.POSTGREST_CONTAINER, "create-post");
  try {
    const response = await makePostgrestRequest(container, "/posts", "POST", body);
    return response;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

app.put("/api/posts/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const container = getContainer(c.env.POSTGREST_CONTAINER, `update-post-${id}`);
  try {
    const response = await makePostgrestRequest(container, `/posts?id=eq.${id}`, "PATCH", body);
    return response;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

app.delete("/api/posts/:id", async (c) => {
  const id = c.req.param("id");
  const container = getContainer(c.env.POSTGREST_CONTAINER, `delete-post-${id}`);
  try {
    const response = await makePostgrestRequest(container, `/posts?id=eq.${id}`, "DELETE");
    return response;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

// Load balanced endpoint for high availability
app.get("/api/lb/*", async (c) => {
  const path = c.req.path.replace("/api/lb", "");
  const container = await loadBalance(c.env.POSTGREST_CONTAINER, 3);
  try {
    const response = await makePostgrestRequest(container, path);
    return response;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

export default app;