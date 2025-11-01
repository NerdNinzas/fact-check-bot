import express from "express";
console.log("Express imported successfully");

const app = express();
app.listen(3000, () => console.log("Test server running"));
