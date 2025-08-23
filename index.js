const express = require("express");
const bodyParser = require("body-parser");
const { MessagingResponse } = require("twilio").twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post("/whatsapp", (req, res) => {
  const twiml = new MessagingResponse();
  const incomingMsg = req.body.Body.toLowerCase();

  // Simple logic
  if (incomingMsg.includes("hi")) {
    twiml.message("Hello! 👋 How can I help you today?");
  } else {
    twiml.message("I only respond to 'hi' for now. 😅");
  }

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

app.listen(3000, () => console.log("Server running on port 3000"));
