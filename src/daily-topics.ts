/** Topics the daily challenge cycles through. Every one has a stable, checkable ranking. */
export const DAILY_TOPICS = [
  "Largest countries by area", "Most populous countries", "Highest mountains in the world", "Largest islands in the world",
  "Longest rivers in the world", "Largest lakes in the world", "Largest deserts in the world", "Most visited countries",
  "Largest cities in Europe by population", "Largest cities in the USA by population", "Largest countries in Africa by area",
  "Largest countries in South America by area", "Largest US states by area", "Most spoken languages by native speakers",
  "Highest-grossing films of all time", "Best-selling video game consoles of all time", "Best-selling music artists of all time",
  "Most-streamed songs on Spotify", "Best-selling books of all time", "Longest-running TV series",
  "Tallest buildings in the world", "Longest bridges in the world", "Busiest airports in the world by passengers",
  "Largest companies in the world by revenue", "Most valuable football clubs", "Premier League all-time top scorers",
  "Countries with the most Olympic gold medals", "Most Grand Slam titles in men's tennis", "Most FIFA World Cup wins by country",
  "Largest national parks in the USA", "Most populous cities in the world", "Largest seas in the world",
  "Biggest tech companies by market value", "Most-subscribed YouTube channels", "Most-visited websites in the world",
  "Largest dog breeds by weight", "Fastest land animals", "Largest land animals", "Longest-living animals",
  "Largest moons in the Solar System", "Most abundant elements in the Earth's crust", "Largest museums by visitors",
  "Largest stadiums in the world by capacity", "Richest countries by GDP", "Largest cities in Africa by population",
  "Most popular tourist cities in the world", "Largest rainforests in the world", "Highest waterfalls in the world",
];

/** Same topic for everyone on a given UTC date. */
export function dailyTopic(date: string): string {
  const days = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  return DAILY_TOPICS[((days % DAILY_TOPICS.length) + DAILY_TOPICS.length) % DAILY_TOPICS.length];
}
