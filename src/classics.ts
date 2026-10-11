import type { Answer } from "./match";

/**
 * Built-in lists. They need no AI, cost nothing, and keep the game playable when the
 * free daily AI allowance is used up. Rankings are stable, widely published figures.
 */
export interface ClassicList {
  id: string;
  title: string;
  basis: string;
  source: string;
  answers: Answer[];
}

const a = (answer: string, aliases: string[] = [], detail?: string): Answer => ({
  answer,
  aliases,
  ...(detail ? { detail } : {}),
});

export const CLASSICS: ClassicList[] = [
  {
    id: "mountains",
    title: "Highest mountains in the world",
    basis: "Height above sea level",
    source: "Wikipedia: List of highest mountains on Earth",
    answers: [
      a("Mount Everest", ["Everest", "Chomolungma", "Sagarmatha"], "8,849 m"),
      a("K2", ["Godwin-Austen", "Mount Godwin-Austen", "Chogori"], "8,611 m"),
      a("Kangchenjunga", ["Kanchenjunga", "Kangchendzonga"], "8,586 m"),
      a("Lhotse", [], "8,516 m"),
      a("Makalu", [], "8,485 m"),
      a("Cho Oyu", [], "8,188 m"),
      a("Dhaulagiri", ["Dhaulagiri I"], "8,167 m"),
      a("Manaslu", ["Kutang"], "8,163 m"),
      a("Nanga Parbat", ["Diamer"], "8,126 m"),
      a("Annapurna", ["Annapurna I"], "8,091 m"),
    ],
  },
  {
    id: "islands",
    title: "Largest islands in the world",
    basis: "Land area",
    source: "Wikipedia: List of islands by area",
    answers: [
      a("Greenland"),
      a("New Guinea"),
      a("Borneo"),
      a("Madagascar"),
      a("Baffin Island", ["Baffin"]),
      a("Sumatra"),
      a("Honshu"),
      a("Victoria Island", ["Victoria"]),
      a("Great Britain", ["Britain"]),
      a("Ellesmere Island", ["Ellesmere"]),
    ],
  },
  {
    id: "us-states",
    title: "Largest US states by total area",
    basis: "Total area, including water",
    source: "Wikipedia: List of U.S. states and territories by area",
    answers: [
      a("Alaska"),
      a("Texas"),
      a("California"),
      a("Montana"),
      a("New Mexico"),
      a("Arizona"),
      a("Nevada"),
      a("Colorado"),
      a("Oregon"),
      a("Wyoming"),
    ],
  },
  {
    id: "lakes",
    title: "Largest lakes in the world",
    basis: "Surface area",
    source: "Wikipedia: List of lakes by area",
    answers: [
      a("Caspian Sea", ["Caspian", "Lake Caspian"]),
      a("Lake Superior", ["Superior"]),
      a("Lake Victoria", ["Victoria"]),
      a("Lake Huron", ["Huron"]),
      a("Lake Michigan", ["Michigan"]),
      a("Lake Tanganyika", ["Tanganyika"]),
      a("Lake Baikal", ["Baikal"]),
      a("Great Bear Lake", ["Great Bear"]),
      a("Lake Malawi", ["Malawi", "Lake Nyasa", "Nyasa"]),
      a("Great Slave Lake", ["Great Slave"]),
    ],
  },
  {
    id: "africa",
    title: "Largest countries in Africa by area",
    basis: "Total area",
    source: "Wikipedia: List of countries and dependencies by area",
    answers: [
      a("Algeria"),
      a("Democratic Republic of the Congo", ["DR Congo", "DRC", "Congo", "Democratic Republic of Congo", "Congo-Kinshasa"]),
      a("Sudan"),
      a("Libya"),
      a("Chad"),
      a("Niger"),
      a("Angola"),
      a("Mali"),
      a("South Africa"),
      a("Ethiopia"),
    ],
  },
  {
    id: "south-america",
    title: "Largest countries in South America by area",
    basis: "Total area",
    source: "Wikipedia: List of countries and dependencies by area",
    answers: [
      a("Brazil"),
      a("Argentina"),
      a("Peru"),
      a("Colombia"),
      a("Bolivia"),
      a("Venezuela"),
      a("Chile"),
      a("Paraguay"),
      a("Ecuador"),
      a("Guyana"),
    ],
  },
];

export const getClassic = (id: string): ClassicList | undefined => CLASSICS.find((c) => c.id === id);
