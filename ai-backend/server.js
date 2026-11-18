const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { OpenAI } = require('openai'); 
const mysql = require('mysql2/promise'); // samos mysql2 

const app = express();
app.use(express.json());
app.use(cors());

// Configurar el acceso a la bd
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: '', 
  database: 'sakila',
  port: 3306
};

//OpenRouter
const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

// herramientas (Tools) que la ai puede usar para consultar la db
const tools = [
  {
    type: "function",
    function: {
      name: "ejecutar_consulta_sql",
      description: "Ejecuta una consulta SQL de solo lectura (SELECT) en la base de datos Sakila para responder preguntas sobre películas, actores, clientes, rentas e inventario.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "La sentencia SQL SELECT válida a ejecutar en MySQL (ej: SELECT title, release_year FROM film LIMIT 5;)"
          }
        },
        required: ["query"]
      }
    }
  }
];

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    const messages = [...(history || []), { role: 'user', content: message }];

    // 1 llamada a la ai con las herramientas disponibles
    const response = await openrouter.chat.completions.create({
      model: 'openai/gpt-4o-mini', 
      messages: messages,
      tools: tools,
      tool_choice: "auto",
    });

    const responseMessage = response.choices[0].message;

    // 2 verificar si la ai decidió llamar a una función (herramienta de base de datos)
    if (responseMessage.tool_calls) {
      const toolCall = responseMessage.tool_calls[0];
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);

      if (functionName === "ejecutar_consulta_sql") {
        let dbResult;
        try {
          // conectarse a la db y ejecutar la consulta
          const connection = await mysql.createConnection(dbConfig);
          
          // seguridad basica
          const sqlQuery = functionArgs.query.trim();
          if (!sqlQuery.toLowerCase().startsWith('select')) {
            throw new Error("Solo se permiten consultas de lectura (SELECT).");
          }

          const [rows] = await connection.execute(sqlQuery);
          await connection.end();
          dbResult = JSON.stringify(rows);
        } catch (dbError) {
          dbResult = JSON.stringify({ error: dbError.message });
        }

        // herramienta al historial de mensajes
        messages.push(responseMessage);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: dbResult,
        });

        // 3 segunda llamada a la ai para que procese el resultado de la db y se lo de al usuario
        const secondResponse = await openrouter.chat.completions.create({
          model: 'openai/gpt-4o-mini',
          messages: messages,
        });

        return res.json({ reply: secondResponse.choices[0].message.content });
      }
    }

    // Si la ai respondio sin usar la base de datos
    res.json({ reply: responseMessage.content });

  } catch (error) {
    console.error('Error en el servidor:', error);
    res.status(500).json({ error: 'Error interno al procesar la solicitud' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});