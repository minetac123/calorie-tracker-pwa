// Main Tools Registry for FitAI MCP Server
const { registerWorkoutTools } = require('./tools_workout');
const { registerNutritionBodyTools } = require('./tools_nutrition_body');
const { registerStatsProfileTools } = require('./tools_stats_profile');

function registerTools(client) {
  return [
    ...registerWorkoutTools(client),
    ...registerNutritionBodyTools(client),
    ...registerStatsProfileTools(client)
  ];
}

module.exports = { registerTools };
