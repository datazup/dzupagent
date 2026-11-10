import { AgentCard as SDKAgentCard } from "@a2a-js/sdk";
import type { AgentCard } from "../agent-card.js";

export interface AgentCardV1Options {
  authType?: "bearer" | "api-key" | "none";
}

/** Absent/empty and all pre-v1 headers retain the existing dispatcher. */
export function isA2AV1Request(version: string | undefined): boolean {
  return Number.parseInt(version?.trim() ?? "", 10) >= 1;
}

export function toAgentCardV1(
  card: AgentCard,
  opts: AgentCardV1Options = {}
): SDKAgentCard {
  const authType = opts.authType ?? card.authentication?.type ?? "none";
  const source = card.skills ?? card.capabilities;
  // Use the SDK codec for its complete public model, including proto defaults.
  return SDKAgentCard.fromJSON({
    name: card.name,
    description: card.description,
    version: card.version,
    supportedInterfaces: [{
      url: `${card.url.replace(/\/+$/, "")}/a2a`,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
      tenant: "",
    }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [],
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    securitySchemes: authType === "none" ? {} : {
      authentication: authType === "bearer"
        ? { httpAuthSecurityScheme: { scheme: "Bearer" } }
        : { apiKeySecurityScheme: {
            location: "header",
            name: "Authorization",
            description: "API key supplied as Bearer <key>",
          } },
    },
    securityRequirements: authType === "none" ? [] : [{ schemes: { authentication: { list: [] } } }],
    skills: source.map(({ name, description }) => ({
      id: name, name, description, tags: [], examples: [],
      inputModes: ["text/plain"], outputModes: ["text/plain"],
    })),
    signatures: [],
  });
}
