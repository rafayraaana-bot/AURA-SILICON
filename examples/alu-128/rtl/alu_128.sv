`timescale 1ns/1ps

module alu_128 (
  input  logic [127:0] operand_a,
  input  logic [127:0] operand_b,
  input  logic [3:0]   opcode,
  output logic [127:0] result,
  output logic         carry_out,
  output logic         overflow,
  output logic         zero,
  output logic         negative,
  output logic         valid_opcode
);
  localparam logic [3:0] OP_ADD  = 4'h0;
  localparam logic [3:0] OP_SUB  = 4'h1;
  localparam logic [3:0] OP_AND  = 4'h2;
  localparam logic [3:0] OP_OR   = 4'h3;
  localparam logic [3:0] OP_XOR  = 4'h4;
  localparam logic [3:0] OP_NOT  = 4'h5;
  localparam logic [3:0] OP_SLL  = 4'h6;
  localparam logic [3:0] OP_SRL  = 4'h7;
  localparam logic [3:0] OP_SRA  = 4'h8;
  localparam logic [3:0] OP_ROL  = 4'h9;
  localparam logic [3:0] OP_ROR  = 4'hA;
  localparam logic [3:0] OP_EQ   = 4'hB;
  localparam logic [3:0] OP_SLT  = 4'hC;
  localparam logic [3:0] OP_ULT  = 4'hD;

  logic [128:0] extended_sum;
  logic signed [127:0] signed_a;
  logic signed [127:0] signed_b;
  logic [6:0] shift_amount;

  always @* begin
    result = '0;
    carry_out = 1'b0;
    overflow = 1'b0;
    valid_opcode = 1'b1;
    extended_sum = '0;
    signed_a = $signed(operand_a);
    signed_b = $signed(operand_b);
    shift_amount = operand_b[6:0];

    case (opcode)
      OP_ADD: begin
        extended_sum = {1'b0, operand_a} + {1'b0, operand_b};
        result = extended_sum[127:0];
        carry_out = extended_sum[128];
        overflow = (~(operand_a[127] ^ operand_b[127])) &
          (result[127] ^ operand_a[127]);
      end
      OP_SUB: begin
        result = operand_a - operand_b;
        carry_out = operand_a >= operand_b;
        overflow = (operand_a[127] ^ operand_b[127]) &
          (result[127] ^ operand_a[127]);
      end
      OP_AND: result = operand_a & operand_b;
      OP_OR:  result = operand_a | operand_b;
      OP_XOR: result = operand_a ^ operand_b;
      OP_NOT: result = ~operand_a;
      OP_SLL: result = operand_a << shift_amount;
      OP_SRL: result = operand_a >> shift_amount;
      OP_SRA: result = signed_a >>> shift_amount;
      OP_ROL: begin
        if (shift_amount == 0)
          result = operand_a;
        else
          result = (operand_a << shift_amount) |
            (operand_a >> (128 - shift_amount));
      end
      OP_ROR: begin
        if (shift_amount == 0)
          result = operand_a;
        else
          result = (operand_a >> shift_amount) |
            (operand_a << (128 - shift_amount));
      end
      OP_EQ:  result = {{127{1'b0}}, operand_a == operand_b};
      OP_SLT: result = {{127{1'b0}}, signed_a < signed_b};
      OP_ULT: result = {{127{1'b0}}, operand_a < operand_b};
      default: valid_opcode = 1'b0;
    endcase

    zero = (result == '0);
    negative = result[127];
  end
endmodule
