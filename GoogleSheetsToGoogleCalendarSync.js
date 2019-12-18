require('dotenv').config() // load gcloud credentials in dev

const dayjs = require('dayjs')

const {
  ManagerFactory: GSuiteManagerFactory,
} = require('@redeemerbc/gsuite')
const {serialize} = require('@redeemerbc/serialize')
const {Secret} = require('@redeemerbc/secret')
const {MasterSchedule} = require('./lib/redeemerbc/schedules')
const {PeopleMapper} = require('./lib/redeemerbc')

require('array.prototype.flat').shim()

// TODO: calendar scheduling UI
// * Create a calendar for each position - CM Littles, CM Kids, Setup Truck, etc
// * Associate eligible members with each calendar
// * Create an "Unavailable" calendar with all-day events to capture times when folks are out of town
// * Provide an interface for editing calendar entries
// * Support auto-filling the schedule

/*
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
*/

class GoogleSheetsToGoogleCalendarSync {
  async run() {
    this.gsuiteServiceAccount = await new Secret('GsuiteServiceAccount').get()

    // TODO: GSuite "Error: Rate Limit Exceeded"
    // TODO: GSuite "Calendar usage limits exceeded"
    const masterSchedule = await this.getSheetsMasterSchedule()

    Object.keys(masterSchedule.scheduleGroups).forEach((calendarId) => {
      const scheduleGroup = masterSchedule.scheduleGroups[calendarId]
      this.syncScheduleGroupToGoogleCalendar(calendarId, scheduleGroup)
    })
  }

  async buildGSuitePeopleMapper() {
    const gsuiteContacts = await this.getGSuiteContacts()
    return new PeopleMapper(gsuiteContacts)
  }

  async getGSuiteContacts() {
    const scopes = [
      'https://www.googleapis.com/auth/contacts.readonly', // read-only acccess to contact lists
    ]
    const manager = await GSuiteManagerFactory.peopleManager(scopes, this.gsuiteServiceAccount)

    return manager.getContacts({
      personFields: 'names,emailAddresses',
    })
  }

  async getSheetsMasterSchedule() {
    const scopes = [
      'https://www.googleapis.com/auth/spreadsheets.readonly', // read-only access to spreadsheets
    ]
    const manager = await GSuiteManagerFactory.sheetsManager(scopes, this.gsuiteServiceAccount)
    const masterScheduleSheetId = '1RMPEOOnIixOftIKt5VGA1LBQFoWh0-_ohnt34JTnpWw'
    const masterScheduleSheet = await manager.getSpreadsheet(masterScheduleSheetId)
    // const sheet = masterScheduleSheet.getSheet(0) // master schedule
    const sheet = masterScheduleSheet.getSheet(1) // scripture
    const allCells = await manager.getRange({
      spreadsheetId: masterScheduleSheetId,
      range: sheet.sheetName,
      majorDimension: 'COLUMNS',
      valueRenderOption: 'FORMULA',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    })
    return new MasterSchedule({data: allCells.data, sheet})
  }

  async syncScheduleGroupToGoogleCalendar(calendarId, scheduleGroup) {
    // TODO: CalendarManager and friends should provide scope enums: READ_WRITE, READ_ONLY
    const scopes = [
      'https://www.googleapis.com/auth/calendar', // read/write acccess to calendar entries
    ]
    const manager = await GSuiteManagerFactory.calendarManager(scopes, this.gsuiteServiceAccount)

    const events = scheduleGroup.reduce((eventList, schedule) => {
      eventList.push(schedule.events)
      return eventList
    }, []).flat()
    // TODO: timeMin should be max(firstEvent, today()) - that is, don't change events that already happened
    // - need to also filter out old scheduleEvents so we don't re-create old events
    const firstEvent = events[0]
    const lastEvent = events.slice(-1).pop()
    const calendar = await manager.getCalendar(calendarId)
    const existingCalendarEvents = await calendar.getEvents({
      singleEvents: true,
      timeMin: firstEvent.date.startOf('day').toISOString(),
      timeMax: lastEvent.date.endOf('day').toISOString(),
    })

    const peopleMapper = await this.buildGSuitePeopleMapper()
    const scheduleEvents = events.map(e => e.simulateAGoogleCalendarEvent(calendar, peopleMapper))

    class EventSyncer {
      constructor(options = {}) {
        /*
        ow(options, ow.exactShape({
          scheduleEvent: ow.optional.object,
          calendarEvent: ow.optional.object,
        }))
        */
        this.props = options
      }

      get scheduleEvent() {
        return this.props.scheduleEvent
      }

      set scheduleEvent(scheduleEvent) {
        this.props.scheduleEvent = scheduleEvent
      }

      get calendarEvent() {
        return this.props.calendarEvent
      }

      set calendarEvent(calendarEvent) {
        this.props.calendarEvent = calendarEvent
      }

      get shouldDeleteCalendarEvent() {
        return this.calendarEvent && !this.scheduleEvent
      }

      get shouldCreateCalendarEvent() {
        return !this.calendarEvent && this.scheduleEvent
      }

      serializeEvent(event) { // eslint-disable-line class-methods-use-this
        return (`${event.label} - `
          + `${dayjs(event.start).toISOString()} - `
          + `${dayjs(event.end).toISOString()} - `
          + `${event.attendees.sort()} - `
          + `${event.description || ''}`)
          .replace('\n', ' ')
      }

      serializeCalendarEvent() {
        return this.serializeEvent(this.calendarEvent)
      }

      serializeScheduleEvent() {
        return this.serializeEvent(this.scheduleEvent)
      }

      /*
      get eventsAreSynced() {
        return this.scheduleEvent && this.calendarEvent && !this.shouldUpdateCalendarEvent
      }
      */

      get shouldUpdateCalendarEvent() {
        return this.serializeCalendarEvent() !== this.serializeScheduleEvent()
      }

      get syncActionName() {
        if (this.shouldDeleteCalendarEvent) {
          return 'delete'
        }
        if (this.shouldCreateCalendarEvent) {
          return 'create'
        }
        if (this.shouldUpdateCalendarEvent) {
          return 'update'
        }
        return 'synced'
      }

      async sync() {
        // return Promise.resolve()

        if (this.shouldDeleteCalendarEvent) {
          return this.deleteCalendarEvent()
        }
        if (this.shouldCreateCalendarEvent) {
          return this.createCalendarEvent()
        }
        if (this.shouldUpdateCalendarEvent) {
          return this.updateCalendarEvent()
        }
        return Promise.resolve()
      }

      async deleteCalendarEvent() {
        return this.calendarEvent.deleteEvent({
          sendUpdates: 'none',
        })
      }

      async createCalendarEvent() {
        // TODO: reconcile all this naming: scheduleEvent -> spreadsheetEvent
        return this.scheduleEvent.createEvent({
          sendUpdates: 'none',
        })
      }

      async updateCalendarEvent() {
        return this.calendarEvent.updateEvent({
          sendUpdates: 'all',
          resource: this.scheduleEvent.properties,
        })
      }
    }

    class EventMapper {
      constructor() {
        this.eventMap = {}
      }

      push(event) {
        // ow(event, ow.object)
        const eventId = `${event.label} - ${dayjs(event.start).startOf('day')}`
        const syncer = this.eventMap[eventId] || new EventSyncer()
        if (event.id) {
          syncer.calendarEvent = event
        } else {
          syncer.scheduleEvent = event
        }
        this.eventMap[eventId] = syncer
      }

      get eventPairs() {
        return Object.values(this.eventMap)
      }

      toActionBuckets() {
        return this.eventPairs.reduce((buckets, syncer) => {
          const action = syncer.syncActionName
          buckets[action] = buckets[action] || [] // eslint-disable-line no-param-reassign
          buckets[action].push(syncer)
          return buckets
        }, {})
      }
    }

    const eventMapper = new EventMapper()
    scheduleEvents.concat(existingCalendarEvents).forEach(event => eventMapper.push(event))
    const eventActionBuckets = Object.assign(
      {
        synced: [],
        update: [],
        create: [],
        delete: [],
      },
      eventMapper.toActionBuckets(),
    )

    /*
    console.info(`These Spreadsheet events have previously been synced to Calendar '${calendar.summary}'`,
      eventActionBuckets.synced.map(e => e.serializeCalendarEvent()))
    */

    console.info(`These Spreadsheet events will be updated in Calendar '${calendar.summary}'`,
      eventActionBuckets.update.map(e => `${e.serializeCalendarEvent()} => ${e.serializeScheduleEvent()}`))
    await serialize(eventActionBuckets.update.map(e => () => e.sync()))

    console.info(`These Spreadsheet events will be created in Calendar '${calendar.summary}'`,
      eventActionBuckets.create.map(e => e.serializeScheduleEvent()))
    await serialize(eventActionBuckets.create.map(e => () => e.sync()))

    console.info(`These Calendar events will be deleted from Calendar '${calendar.summary}'`,
      eventActionBuckets.delete.map(e => e.serializeCalendarEvent()))
    await serialize(eventActionBuckets.delete.map(e => () => e.sync()))
  }
}

new GoogleSheetsToGoogleCalendarSync().run()
  .catch((e) => {
    console.log(e)
    throw e
  })
