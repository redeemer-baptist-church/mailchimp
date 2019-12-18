// Some GSuite products describe people by email address, others by name
// Given a list of Google People (from the Contacts) API, this class
// will attempt to map among the various types of GSuite people objects.
// Many caveats apply...

class PeopleMapper {
  constructor(listOfPeople) {
    this._mapOfPeopleByEmail = listOfPeople.reduce((map, person) => {
      map[person.email.toLowerCase()] = person // eslint-disable-line no-param-reassign
      return map
    }, {})
    this._mapOfPeopleByFullName = listOfPeople.reduce((map, person) => {
      map[person.fullName.toLowerCase()] = person // eslint-disable-line no-param-reassign
      return map
    }, {})
  }

  personByFullName(fullName) {
    const person = this._mapOfPeopleByFullName[fullName.toLowerCase()]
    return this.validatePerson(person, fullName)
  }

  personByEmail(email) {
    const person = this._mapOfPeopleByEmail[email.toLowerCase()]
    return this.validatePerson(person, email)
  }

  validatePerson(person, identifier) { // eslint-disable-line class-methods-use-this
    if (!person) {
      // throw new Error(`'${identifier}' not found in the People database!`)
    }
    return person
  }
}

module.exports = {PeopleMapper}
