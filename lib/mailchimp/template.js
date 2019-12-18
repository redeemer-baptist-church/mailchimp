class Template {
  constructor(listJson, client) {
    this.json = listJson
    this.client = client
  }

  get id() {
    return this.json.id
  }

  get name() {
    return this.json.name
  }
}

module.exports = {Template}
