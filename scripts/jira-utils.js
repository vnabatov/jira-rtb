const moment = require('moment')
const JiraClient = require('jira-connector')
const { host, username, password } = require('./config/jira.config.json')

const {
  loadTasks = false,
  maxResults = 1000,
  updateDbDirectly = true,
  jql = 'key=CPP0-1061',
  jql2 = `issuetype = Task AND issueFunction in linkedIssuesOf('key=CPP0-1061')`
} = require('yargs').argv

const jira = new JiraClient({ host, basic_auth: { username, password } })
const getIssuesByFilter = async (jql) => jira.search.search({ jql, maxResults })
let alreadyAdded = []
const date = moment().format('YYYY-MM-DD')
const time = moment().format('h:mm:ss')

console.log({ maxResults, loadTasks, jql, jql2 })

const prepareAlreadyAdded = (dbJSON) => {
  alreadyAdded = []
  dbJSON.stories.forEach(({ id }) => {
    alreadyAdded.push(id)
  })

  dbJSON.tasks.forEach(({ id }) => {
    alreadyAdded.push(id)
  })
}

const loadStoriesFromJira = (jiraData, dbJSON) => {
  const storiesFromJira = jiraData.issues.map(({ key, fields: { summary, customfield_11220: epicId } }) => ({ id: key, summary, epicId }))
  const newStories = []
  storiesFromJira.forEach(story => {
    if (!alreadyAdded.includes(story.id)) {
      if (updateDbDirectly) {
        dbJSON.stories.push({ ...story, date, time })
      }

      newStories.push({ ...story, date, time })

      alreadyAdded.push(story.id)
      console.log('Added:', story.id)
    } else {
      console.log('Already exists:', story.id)
    }
  })
  return newStories
}

const getInwardOutwardIssue = (issuelink, inwardIssues = true, outwardIssues = true) => {
  if (outwardIssues && issuelink.outwardIssue) {
    return { ...issuelink.outwardIssue, relationIO: 'outward' }
  }
  if (inwardIssues && issuelink.inwardIssue) {
    return { ...issuelink.inwardIssue, relationIO: 'inward' }
  }
  return null
}

const loadTasksFromJira = (jiraData, dbJSON) => {
  const newTasks = []

  jiraData.issues.forEach(task => {
    const teamId = task.key.split('-')[0]
    let sprint = dbJSON.sprints.find(({ id }) => id === teamId)

    if (!sprint) {
      console.log('sprint not found, trying default')
      sprint = dbJSON.sprints.find(({ id }) => id === 'default')
    }

    if (sprint) {
      let taskSprint = ''
      try {
        taskSprint = task.fields.customfield_10942 ? /.+name=([^,]+)/.exec(task.fields.customfield_10942)[1] : ''
      } catch (e) {
        console.log(`can't get a sprint`, e)
      }

      let version = ''
      if (task.fields.fixVersions.length) {
        try {
          version = task.fields.fixVersions.map(({ name }) => name).join(',')
        } catch (e) {
          console.log(`can't get a version`, e)
        }
      }

      let storyKey = task.fields.customfield_16525
      try {
        if (!storyKey && task.fields.issueLinks && task.fields.issueLinks.length) {
          task.fields.issueLinks.forEach(issueLink => {
            if (issueLink.type.name === 'Story') {
              storyKey = issueLink.id
            }
          })
        }
      } catch (e) {
        console.log(`can't get a story key`, e)
      }

      const issueLinks = task.fields.issuelinks
      const relatedIssueTypes = ['Task', 'Sub-task']
      const checkRelations = []
      const ignoreWithTextInSummary = ''
      const relatedIssues = []

      issueLinks.forEach(issuelink => {
        const issue = getInwardOutwardIssue(issuelink)
        const relation = issuelink.type[issue.relationIO]

        console.log('add?', issue.key)

        if (!relatedIssueTypes.includes(issue.fields.issuetype.name)) {
          console.log(`! Skipped ${issue.key} by IssueType [[${issue.fields.issuetype.name}]]`)
        } else if (checkRelations.length !== 0 && !checkRelations.includes(relation)) {
          console.log(`! Skipped ${issue.key} by Relation Type ${relation}`)
        } else if (ignoreWithTextInSummary !== '' && issue.fields.summary.includes(ignoreWithTextInSummary)) {
          console.log(`! Skipped ${issue.key} by Text in Summary ${issue.fields.summary} / '${ignoreWithTextInSummary}'`)
        } else if (issue.fields.status.name === 'Closed') {
          console.log('skipped by status', 'Closed')
        } else {
          console.log('add', issue.key)
          relatedIssues.push(issue.key)
        }
      })
      if (task.key === 'CPP2-1048') {
        console.log('task.fields', JSON.stringify(task.fields))
      }
      const taskData = {
        id: task.key,
        summary: task.fields.summary,
        story: storyKey,
        related: relatedIssues.length ? relatedIssues.join(',') : '',
        sp: task.fields.customfield_10223 || '',
        date,
        time,
        dateChange: date,
        timeChange: time,
        v: version,
        sprint: taskSprint
      }

      const getSprintToColumn = (sprint) => {
        if (!sprint || !sprint.includes) {
          return null
        }

        if (sprint.includes(' 14')) {
          return 'column-2'
        } else if (sprint.includes(' 15')) {
          return 'column-3'
        } else if (sprint.includes(' 16')) {
          return 'column-4'
        } else if (sprint.includes(' 17')) {
          return 'column-5'
        } else if (sprint.includes(' 18')) {
          return 'column-6'
        } else {
          return null
        }
      }
      const newSprint = (taskSprint && dbJSON.sprintMap && taskSprint && dbJSON.sprintMap[taskSprint]) || getSprintToColumn(taskSprint) || 'column-1'

      if (!alreadyAdded.includes(task.key) && task.status !== 'Closed') {
        if (updateDbDirectly) {
          dbJSON.tasks.push({ ...taskData, teamName: sprint.teamName, status: undefined })
          sprint.columns[newSprint].taskIds.push(taskData.id)

          console.log('sprint (team) = [', sprint && sprint.teamName, '] task =', taskData.id)
        }

        newTasks.push({ ...taskData, teamName: sprint.teamName, status: undefined })

        alreadyAdded.push(taskData.id)
      } else {
        console.log('Already exists: sprint (team) = [', sprint && sprint.teamName, '] task =', task.key)

        // moving to sprint set in jira
        Object.entries(sprint.columns).forEach(([key, val]) => {
          console.log(key, val)
          if (val.taskIds && val.taskIds.includes(taskData.id)) {
            sprint.columns[key].taskIds = val.taskIds.filter(id => id !== taskData.id)
          }
        })
        sprint.columns[newSprint].taskIds.push(taskData.id)
      }
    } else {
      console.log('sprint not found')
    }
  })
  return newTasks
}

module.exports = { prepareAlreadyAdded, getIssuesByFilter, loadStoriesFromJira, loadTasksFromJira }
