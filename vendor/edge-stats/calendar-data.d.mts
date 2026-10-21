export interface BundledEventCalendar { event: string; version: string; sources: string[]; notes?: string; coverage: { from: string; to: string }; dates: string[] }
export declare const eventCalendars: readonly BundledEventCalendar[];
export declare const holidayCalendars: { cme: import("./src/calendar/types").HolidayCalendar; nyse: import("./src/calendar/types").HolidayCalendar };
