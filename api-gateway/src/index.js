const express = require('express');
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('API do Kanban operante.');
});

app.listen(4000, () => console.log('API Gateway is running on port 4000'));