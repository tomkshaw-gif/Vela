import cpi from "./data/events/cpi.json" with { type: "json" };
import fomc from "./data/events/fomc.json" with { type: "json" };
import nfp from "./data/events/nfp.json" with { type: "json" };
import opex from "./data/events/opex.json" with { type: "json" };
import cme from "./data/holidays/cme.json" with { type: "json" };
import nyse from "./data/holidays/nyse.json" with { type: "json" };

export const eventCalendars = [cpi, fomc, nfp, opex];
export const holidayCalendars = { cme, nyse };
