import { PrismaClient } from '@prisma/client'
import { user_register_schema, user_login_schema, user_update_schema, user_get_schema } from '../schemas/user.schema.js'
import { validate } from '../libraries/validation.js';
import { randStr } from '../libraries/misc.js';
import { Globals } from '../libraries/globals.js';
import bcrypt from 'bcrypt';
import * as dotenv from 'dotenv'

const prisma = new PrismaClient()
dotenv.config()

export class User {

  //* Manual construction
  //! not effects the database, use create or login
  constructor(company_code, username, user_details) {
    this.username = username.toLowerCase()      //. username to lover case
    this.company_code = company_code
    if (user_details) {                         //. if given details save it
      this.user_details = user_details
      delete this.user_details['password']
    }
  }

  //* Initiate Details
  async initDetails() {
    this.user_details = await prisma.User.findUnique(             //d get details from db
      { where: { username: this.username } }
    )
    if (this.user_details === null || this.company_code !== this.user_details.company_code) throw new Error('user ' + this.username + ' not found')  //r if cant get details give error
  }

  //* Get Details of user
  //r Returns this.user_details
  getDetails() { 
    if (this.user_details) return this.user_details                                         //. try to get details
    else throw new Error('User details not initialized. first use initDetails() (async)')   //. if not saved give error
  }

  //* Logout from user
  logout() {
    if (!this.token) throw new Error('Not logged in')   //r if no token give error
    delete Globals.auth_tokens[this.token]              //. delete token from globals
  }

  //* Generate new token
  async generateToken() {
    if (!this.user_details) await this.initDetails()                          //. try to get details
    this.token = 'RT-Token_' + randStr(parseInt(process.env.TOKEN_LENGTH))    //. create a token string

    //* Delete the token if user logged in already
    for (let t in Globals.auth_tokens) {                                //? Loop the auth tokens
      if (Globals.auth_tokens[t].username === this.username) {          //. control the username
        delete Globals.auth_tokens[t]                                   //. delete the token record
        break;
      }
    }

    this.token_expiration = Date.now() + parseInt(process.env.TOKEN_TIMEOUT)    //. generate an expiration time
    Globals.auth_tokens[this.token] = this;                                     //. save token to globals

  }
  
  //* Remove the user from database
  async removeUser() {
    if (!this.user_details) await this.initDetails()                          //. control the details
    if (this.token) delete Globals.auth_tokens[this.token]                    //. remove token if exists
    return await prisma.User.delete({ where: { username: this.username } })   //d delete user from db
  }

  //* Update user
  async update(details) {
    validate(details, user_update_schema)

    if (!this.user_details) await this.initDetails()

    if (details.password) details.password = await bcrypt.hash(details.password, parseInt(process.env.HASH_SALT_ROUNDS))

    let ndetails = await prisma.User.update({
      where: { username: this.username },
      data: {
        ...details,
        old_password: (details.password) ? this.user_details.password : undefined
      }
    })

    this.user_details = ndetails
    return this
  }

  //-- Static constructor methods

  //* Create new user
  //r Returns User
  static async create(company_code, user_details) {
    validate(user_details, user_register_schema)                        //. validate input schema

    user_details.displayname = user_details.username                    //. set displayname
    user_details.username = user_details.username.toLowerCase()         //. lovercase the username
    user_details.password = await bcrypt.hash(user_details.password, parseInt(process.env.HASH_SALT_ROUNDS))  //. hash pass
    if (!user_details.admin) user_details.admin = false
    if (!user_details.register_date) user_details.register_date = new Date()
    if (!user_details.lastlogin_date) user_details.lastlogin_date = new Date()
    if (!user_details.lastlogin_ip) user_details.lastlogin_ip = user_details.register_ip


    let control_resp = await prisma.User.findUnique(                    //d control is username exists
      { where: { username: user_details.username } }
    )
    if (control_resp !== null) throw new Error('User already exists')   //r give error if user exists

    await prisma.User.create({data: {...user_details, company_code}})                      //d create user in db

    let user = new User(company_code, user_details.username, user_details)            //. create User object
    await user.generateToken()                                          //. generate token

    return user                                                         //r return the User object
  }

  //* Login to a user
  //r Returns User
  static async login(login_details) {
    validate(login_details, user_login_schema)                        //. validate input schema

    let u_details = await prisma.User.findUnique(                     //d try to get user details from db
      { where: { username: login_details.username.toLowerCase() } }
    )
    if (u_details === null) throw new Error('User not found')         //r give error if user not exists
    
    let is_pass_corr = await bcrypt.compare(login_details.password, u_details.password)   //. control password
    if (!is_pass_corr) throw new Error('Password is not correct')                         //r give error if pass not correct


    await prisma.User.update({                                        //d update lastlogin info
      where: { username: u_details.username },
      data: { 
        lastlogin_ip: (login_details.ip)                              //. if ip is given
          ? login_details.ip                                          //. send the ip
          : u_details.lastlogin_ip,                                   //. else send last saved ip
        lastlogin_date: (new Date())
      }
    })

    let user = new User(u_details.company_code, u_details.username, u_details)              //. create an User object
    await user.generateToken()                                      //. generate the token

    return user                                                     //r return the User object
  }

  //* Login using a token
  //r Return User
  static tokenLogin(token) {
    if (!Object.keys(Globals.auth_tokens).includes(token)) throw new Error('Incorrect token')   //r if token not found give error

    let exp_time = Globals.auth_tokens[token].token_expiration        //. get the expiration time
    if (exp_time < Date.now()) {                                      //. control expiration time
      delete Globals.auth_tokens[token]                               //. remove token
      throw new Error('Token is expired')                             //r give error
    }

    return Globals.auth_tokens[token]                                 //r give User object from tokens list
  }
  
  //* Get a Stock by Id
  //r Returns Stock object
  static async get(company_code, id) {
    validate(id, user_get_schema)

    let user = new User(company_code, id)
    await user.initDetails()

    return user
  }

  //* Get Stocks with query
  //r Returns array of Stock objects
  static async getMany(company_code, query = {}, pagination = true) {
    if (pagination) {
      if (!query.skip) query.skip = 0
      if (!query.take) query.take = parseInt(process.env.QUERY_LIMIT)
    }

    if (!query.where) query.where = { company_code }
    else query.where.company_code = company_code

    let resps = await prisma.User.findMany(query)
    return resps.map(r => new User(company_code, r.username, r))
  }

  //-- Static util methods

  //* Get count of results
  //r Return integer
  static async count(company_code, extra_query = {}) {
    if (!extra_query.where) extra_query.where = { company_code }
    else extra_query.where.company_code = company_code
    delete extra_query['include']

    let resp = await prisma.User.aggregate({
      _count: true,
      ...extra_query
    })
    if (resp === null) return 0
    return resp['_count']
  }

}
