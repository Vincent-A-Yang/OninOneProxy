import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderConnections } from "@/models";
import { maskApiKey } from "@/lib/crypto/mask";

export const dynamic = "force-dynamic";

// GET /api/providers/[id]/api-keys - List API key masks for a provider
export async function GET(request, { params }) {
  try {
    const { id } = await params;

    // Strategy 1: exact connection id match
    const directConn = await getProviderConnectionById(id);
    if (directConn) {
      const apiKey = directConn.apiKey || "";
      const mask = maskApiKey(apiKey);
      return NextResponse.json({
        keys: [{
          id: directConn.id,
          apiKeyMask: mask,
          label: directConn.name ? `${directConn.name} (${mask})` : mask,
          name: directConn.name || "",
        }],
      });
    }

    // Strategy 2: provider id match (multiple connections)
    const allConnections = await getProviderConnections();
    const matching = allConnections.filter(c => c.provider === id);
    if (matching.length === 0) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const keys = matching.map(c => {
      const apiKey = c.apiKey || "";
      const mask = maskApiKey(apiKey);
      return {
        id: c.id,
        apiKeyMask: mask,
        label: c.name ? `${c.name} (${mask})` : mask,
        name: c.name || "",
      };
    });

    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching API key masks:", error);
    return NextResponse.json({ error: "Failed to fetch API key masks" }, { status: 500 });
  }
}
