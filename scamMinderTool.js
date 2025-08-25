import axios from "axios";

export async function scamMinderTool(url) {
  try {
    const res = await axios.post("https://scamminder.com/rest-api", {
      endpoint: "scam_score",
      website: url
    }, {
      headers: { Authorization: `Bearer ${process.env.SCAMMINDER_API_KEY}` }
    });
    
    return `Scam Score for ${url}: ${res.data.body?.scam_score || "Unknown"}`;
  } catch (err) {
    console.error("ScamMinder API Error:", err);
    return "Could not check scam status.";
  }
}
